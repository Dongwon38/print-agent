// 250417, 로그인 테스트까지 끝난 버전, NOC에 직접 가서 테스트 해야 하는 버전
// node print-agent.js USERNAME PASSWORD, 백엔드에서 설정한 로그인 유효기간 = 30 days
// 250421, 새로 테스트해야하는 버전
// 250421, 토큰 암호화 및 자동 로그인 기능 추가

const express = require("express");
const http = require("http");
const axios = require("axios");
const escpos = require("escpos");
escpos.USB = require("escpos-usb");
const keytar = require("keytar");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// 환경 변수 설정 및 유효성 검사
const API_URL = process.env.KTR_API_URL;
const PORT = parseInt(process.env.PORT, 10);
const GSTNumber = process.env.GST_NUMBER;
const MAX_LINE_CHARS = parseInt(process.env.MAX_LINE_CHARS, 10);
const ENCRYPTION_SECRET = process.env.PRINTER_ENCRYPTION_SECRET;

if (!API_URL || !PORT || !GSTNumber || !MAX_LINE_CHARS || !ENCRYPTION_SECRET) {
  console.log("Missing required environment variables (KTR_API_URL, PORT, GST_NUMBER, MAX_LINE_CHARS, PRINTER_ENCRYPTION_SECRET)");
  process.exit(1);
}

// 프린터 설정
const VENDOR_ID = parseInt(process.env.PRINTER_VENDOR_ID, 16);
const PRODUCT_ID = parseInt(process.env.PRINTER_PRODUCT_ID, 16);

if (!VENDOR_ID || !PRODUCT_ID) {
  console.log("PRINTER_VENDOR_ID or PRINTER_PRODUCT_ID not set in .env");
  process.exit(1);
}

const devices = escpos.USB.findPrinter();
const targetDevice = devices.find(
  (device) =>
    device.deviceDescriptor.idVendor === VENDOR_ID &&
    device.deviceDescriptor.idProduct === PRODUCT_ID
);

if (!targetDevice) {
  console.log(
    `No USB printer found with Vendor ID: ${VENDOR_ID.toString(16)} and Product ID: ${PRODUCT_ID.toString(16)}`
  );
  process.exit(1);
}

const device = new escpos.USB(
  targetDevice.deviceDescriptor.idVendor,
  targetDevice.deviceDescriptor.idProduct
);
const options = { encoding: "GB18030" };
let printer = null;

let encryptedJwtToken = null;
let pollingInterval = null;

// 로그 파일로 출력
function log(message) {
  const timestamp = new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" });
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage);
  require("fs").appendFile("server.log", logMessage, (err) => {
    if (err) console.error(`Failed to write log: ${err.message || err}`);
  });
}

// JWT_TOKEN 암호화 및 복호화
function encryptToken(token) {
  const cipher = crypto.createCipher("aes-256-cbc", ENCRYPTION_SECRET);
  let encrypted = cipher.update(token, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
}

function decryptToken(encryptedToken) {
  const decipher = crypto.createDecipher("aes-256-cbc", ENCRYPTION_SECRET);
  let decrypted = decipher.update(encryptedToken, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// 자격 증명 저장
async function saveCredentials(username, password) {
  await keytar.setPassword("print-agent-ktr", "credentials", JSON.stringify({ username, password }));
  log("Credentials saved successfully in Windows Credential Manager");
}

// 자격 증명 읽기
async function getCredentials() {
  const creds = await keytar.getPassword("print-agent-ktr", "credentials");
  if (!creds) {
    throw new Error("Credentials not found in Windows Credential Manager");
  }
  return JSON.parse(creds);
}

// 자동 로그인 및 토큰 갱신
async function autoLogin(attempt = 1, maxAttempts = 3) {
  const { username, password } = await getCredentials();
  try {
    log(`Attempting auto-login (attempt ${attempt}/${maxAttempts})...`);
    const response = await axios.post(
      `${API_URL}/login`,
      { username, password },
      { headers: { "Content-Type": "application/json" }, withCredentials: true }
    );
    const token = response.data.token;
    encryptedJwtToken = encryptToken(token);
    log("Auto-login successful");
    return true;
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    log(`Auto-login failed: ${errorMsg}`);
    if (attempt < maxAttempts) {
      log(`Retrying auto-login in 5 seconds...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return autoLogin(attempt + 1, maxAttempts);
    }
    log(`Max login attempts (${maxAttempts}) reached`);
    return false;
  }
}

// 프린터 초기화
async function initializePrinter() {
  return new Promise((resolve, reject) => {
    device.open((error) => {
      if (error) {
        log(`Failed to initialize printer: ${error.message}`);
        reject(error);
      } else {
        printer = new escpos.Printer(device, options);
        log("Printer initialized successfully");
        resolve();
      }
    });
  });
}

// PICKUP 시간 포맷팅 함수
function formatPickupTime(dueAt) {
  if (!dueAt) return "N/A";

  const now = new Date();
  const pickupDate = new Date(dueAt);
  const timeDiffMs = pickupDate - now;
  const timeDiffMinutes = Math.round(timeDiffMs / (1000 * 60));
  const isToday =
    pickupDate.toLocaleDateString("en-US", { timeZone: "America/Vancouver" }) ===
    now.toLocaleDateString("en-US", { timeZone: "America/Vancouver" });

  const timeStr = pickupDate.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Vancouver",
  });

  const dateStr = pickupDate.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Vancouver",
  });

  if (isToday) {
    if (timeDiffMinutes <= 60) {
      return `PICKUP at ${timeStr} (in ${timeDiffMinutes}m)`;
    } else {
      const hours = Math.floor(timeDiffMinutes / 60);
      const minutes = timeDiffMinutes % 60;
      return `PICKUP at ${timeStr} (in ${hours}hrs ${minutes}m)`;
    }
  } else {
    return `PICKUP at ${dateStr}, ${timeStr}`;
  }
}

// 글자 수 계산 (중국어 2칸)
function calculateTextLength(text) {
  let length = 0;
  for (const char of text) {
    if (/[\u4E00-\u9FFF]/.test(char)) {
      length += 2;
    } else {
      length += 1;
    }
  }
  return length;
}

// 가격 포맷팅 함수
function formatPrice(price) {
  const priceStr = Number(price).toFixed(2);
  const priceLength = priceStr.length;
  const padding = Math.max(1, 7 - priceLength);
  const formatted = " ".repeat(padding) + priceStr;
  return formatted;
}

// wrapTextWithPrice 함수
function wrapTextWithPrice(text, prefix, price) {
  const lines = [];
  const priceText = formatPrice(price);
  const priceLength = priceText.length;
  const prefixLength = prefix.length;

  const firstLineAvailableWidth = MAX_LINE_CHARS - prefixLength - priceLength;
  const subsequentLineAvailableWidth = MAX_LINE_CHARS - priceLength;

  let currentLine = "";
  let currentLineLength = 0;
  let isFirstLine = true;

  const chars = [...text];

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const charLength = /[\u4E00-\u9FFF]/.test(char) ? 2 : 1;
    const availableWidth = isFirstLine ? firstLineAvailableWidth : subsequentLineAvailableWidth;

    if (currentLineLength + charLength <= availableWidth) {
      currentLine += char;
      currentLineLength += charLength;
    } else {
      let line;
      const actualLine = isFirstLine ? prefix + currentLine : currentLine;
      const actualLineLength = calculateTextLength(actualLine);
      let spaces;
      if (isFirstLine) {
        spaces = " ".repeat(MAX_LINE_CHARS - (prefixLength + currentLineLength + priceLength));
        line = prefix + currentLine + spaces + priceText;
        isFirstLine = false;
      } else {
        spaces = " ".repeat(MAX_LINE_CHARS - currentLineLength);
        line = currentLine + spaces;
      }
      lines.push(line);

      currentLine = char;
      currentLineLength = charLength;
    }
  }

  if (currentLine) {
    let line;
    const actualLine = isFirstLine ? prefix + currentLine : currentLine;
    const actualLineLength = calculateTextLength(actualLine);
    let spaces;
    if (isFirstLine) {
      spaces = " ".repeat(MAX_LINE_CHARS - (prefixLength + currentLineLength + priceLength));
      line = prefix + currentLine + spaces + priceText;
    } else {
      spaces = " ".repeat(MAX_LINE_CHARS - currentLineLength);
      line = currentLine + spaces;
    }
    lines.push(line);
  }

  return lines;
}

// wrapText 함수
function wrapText(text, maxWidth, addSpacing = false) {
  const lines = [];
  let currentLine = "";
  let currentLineLength = 0;

  for (const char of text) {
    const charLength = /[\u4E00-\u9FFF]/.test(char) ? 2 : 1;
    if (currentLineLength + charLength <= maxWidth) {
      currentLine += char;
      currentLineLength += charLength;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = char;
      currentLineLength = charLength;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  if (addSpacing) {
    return lines.flatMap((line) => [line, "\n"]);
  }
  return lines;
}

// extractChineseText 함수
function extractChineseText(text) {
  const chineseMatch = text.match(/[\u4E00-\u9FFF]+/g);
  return chineseMatch ? chineseMatch.join("") : text;
}

// 고객용 영수증 출력 함수
async function printCustomerReceipt(order, isForStorage = false) {
  const customerName = order.customer_name || "Unknown";
  const orderNumber = order.order_number || "N/A";
  const shortOrderNumber = orderNumber.split("-")[1] || "N/A";
  const pickupTime = formatPickupTime(order.due_at);
  const orderTime = order.created_at
    ? new Date(order.created_at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/Vancouver",
      })
    : "N/A";
  const phone = order.customer_phone || "N/A";
  const items = order.items || [];
  const subtotal = Number(order.subtotal || 0);
  const gst = Number(order.gst || 0);
  const tip = Number(order.tip || 0);
  const total = Number(order.total || 0);

  printer.raw(Buffer.from([0x1b, 0x40])); // 프린터 초기화

  printer
    .font("a")
    .align("LT")
    .style("NORMAL")
    .size(1, 1)
    .text(`${customerName}(${shortOrderNumber})`)
    .size(0, 1)
    .text(pickupTime)
    .size(0, 0)
    .text(`Order at ${orderTime}`)
    .text(`Phone: ${phone}`);

  if (order.customer_notes) {
    printer.text("Customer Notes:");
    wrapText(order.customer_notes, MAX_LINE_CHARS - 2).forEach((line) =>
      printer.text(`  ${line}`)
    );
  }
  printer.text("");
  printer.text("-".repeat(MAX_LINE_CHARS));

  if (items.length === 0) {
    printer.text("No items in this order.");
  } else {
    items.forEach((item, index) => {
      const itemSubtotal = Number(
        item.subtotal || (item.basePrice || item.price) * (item.quantity || 1) || 0
      ).toFixed(2);
      const itemName = `${item.quantity || 1} x ${item.name || item.item_name || "Unknown"}`;
      const prefix = `${item.quantity || 1} x `;

      const lines = wrapTextWithPrice(itemName.slice(prefix.length), prefix, itemSubtotal);
      lines.forEach((line) => printer.text(line));

      if (item.options && item.options.length > 0) {
        item.options.forEach((option) => {
          option.choices.forEach((choice) => {
            let optionText = `${choice.name || "N/A"}`;
            let totalPrice = Number(
              choice.extraPrice || choice.additional_price || choice.price || 0
            );

            if (choice.subOptions && choice.subOptions.length > 0) {
              choice.subOptions.forEach((subOption) => {
                subOption.choices.forEach((subChoice) => {
                  const subPrice = Number(
                    subChoice.extraPrice || subChoice.additional_price || subChoice.price || 0
                  );
                  totalPrice = Number(totalPrice) + Number(subPrice);
                  optionText += ` (${subChoice.name || "N/A"})`;
                });
              });
            }

            totalPrice = totalPrice.toFixed(2);
            const optionPrefix = "- ";
            const optionLines = wrapTextWithPrice(optionText, optionPrefix, totalPrice);
            optionLines.forEach((line) => printer.text(line));
          });
        });
      }

      if (item.specialInstructions) {
        printer.text("- Note: ");
        wrapText(item.specialInstructions, MAX_LINE_CHARS - 2).forEach((line) =>
          printer.text(`  ${line}`)
        );
      }

      if (index < items.length - 1) {
        printer.text("-".repeat(MAX_LINE_CHARS));
      }
    });
  }

  printer
    .text("-".repeat(MAX_LINE_CHARS))
    .align("RT")
    .size(0, 0)
    .text("")
    .text(`Subtotal: ${formatPrice(subtotal.toFixed(2))}`)
    .text(`GST (5%): ${formatPrice(gst.toFixed(2))}`)
    .text(`Tip: ${formatPrice(tip.toFixed(2))}`)
    .size(1, 1)
    .text(`TOTAL: ${formatPrice(total.toFixed(2))}`)
    .size(0, 0);

  printer
    .align("CT")
    .text("")
    .text("Thank you for your order!")
    .text("Kamtou Seafood Restaurant")
    .text("3779 Sexsmith Rd Unit 1298, Richmond, BC V6X 3Z9")
    .text("(604) 285-1668")
    .text(`GST Number: ${GSTNumber}`)
    .feed(3);

  printer.cut();
  await new Promise((resolve, reject) => {
    printer.flush((err) => {
      if (err) {
        log(`Failed to print customer receipt (${isForStorage ? "Storage" : "Customer"}): ${err.message}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// 주방용 영수증 출력 함수
async function printKitchenReceipt(order) {
  const customerName = order.customer_name || "Unknown";
  const orderNumber = order.order_number || "N/A";
  const shortOrderNumber = orderNumber.split("-")[1] || "N/A";
  const pickupTime = formatPickupTime(order.due_at);
  const items = order.items || [];

  if (items.length === 0) {
    log("No items to print for kitchen receipt");
    return;
  }

  for (const [itemIndex, item] of items.entries()) {
    printer.raw(Buffer.from([0x1b, 0x40])); // 프린터 초기화

    printer
      .align("LT")
      .size(1, 1)
      .text(`${customerName}(${shortOrderNumber})`)
      .size(0, 0)
      .text(pickupTime)
      .text("-".repeat(MAX_LINE_CHARS));

    const itemName = `${item.quantity || 1} x ${extractChineseText(item.name || item.item_name || "Unknown")}`;
    printer.size(1, 1);
    wrapText(itemName, MAX_LINE_CHARS).forEach((line) => printer.text(line));

    if (item.options && item.options.length > 0) {
      item.options.forEach((option) => {
        option.choices.forEach((choice) => {
          let optionText = `- ${extractChineseText(choice.name || "N/A")}`;
          if (choice.subOptions && choice.subOptions.length > 0) {
            choice.subOptions.forEach((subOption) => {
              subOption.choices.forEach((subChoice) => {
                optionText += ` (${extractChineseText(subChoice.name || "N/A")})`;
              });
            });
          }
          wrapText(optionText, MAX_LINE_CHARS).forEach((line) =>
            printer.size(0, 0).text("\n").size(1, 1).text(line)
          );
        });
      });
    }

    if (item.specialInstructions) {
      printer.size(1, 1);
      printer.text("- Note: ");
      wrapText(item.specialInstructions, MAX_LINE_CHARS - 2).forEach((line) =>
        printer.text(`  ${line}`)
      );
    }

    printer.size(0, 0).feed(2);

    printer.cut();
    await new Promise((resolve, reject) => {
      printer.flush((err) => {
        if (err) {
          log(`Failed to print kitchen receipt item ${itemIndex + 1}: ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}

// 동적 데이터로 영수증 출력
async function printOrder(order) {
  let printerClosed = false;
  try {
    let cart = [];
    if (order.cart) {
      try {
        cart = JSON.parse(order.cart);
      } catch (e) {
        log(`Failed to parse cart for order #${order.order_number}: ${e.message}`);
        return;
      }
    }

    order.items = cart;

    await printCustomerReceipt(order, false);
    await printCustomerReceipt(order, true);
    await printKitchenReceipt(order);

    try {
      const token = decryptToken(encryptedJwtToken);
      await axios.post(
        `${API_URL}/update-print-status`,
        { order_id: order.id, print_status: "printed" },
        { headers: { Cookie: `jwt_token=${token}` } }
      );
    } catch (error) {
      log(`Failed to update print status for order #${order.id}: ${error.message}`);
      return;
    }

    log(`Order #${order.order_number} printed successfully`);
  } catch (error) {
    log(`Error printing order #${order.order_number || "N/A"}: ${error.message}`);
  } finally {
    if (printer && !printerClosed) {
      try {
        await new Promise((resolve, reject) => {
          printer.flush((err) => {
            if (err) {
              log(`Failed to flush printer buffer: ${err.message}`);
              reject(err);
            } else {
              printer.close(() => {
                log("Printer closed successfully");
                printerClosed = true;
                resolve();
              });
            }
          });
        });
      } catch (error) {
        log(`Error closing printer: ${error.message}`);
      }
    }
  }
}

// API 폴링
async function pollOrders() {
  if (!encryptedJwtToken) {
    const loginSuccess = await autoLogin();
    if (!loginSuccess) {
      log("Failed to login after max attempts, exiting...");
      process.exit(1);
    }
  }

  try {
    const token = decryptToken(encryptedJwtToken);
    const response = await axios.get(`${API_URL}/pending-orders`, {
      headers: { Cookie: `jwt_token=${token}` },
    });
    const orders = response.data || [];
    const time = new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" });

    if (orders.length > 0) {
      log(`Found ${orders.length} new orders`);
      for (const order of orders) {
        if (!order.print_status && order.payment_status === "paid") {
          log(`Printing order #${order.order_number || "N/A"}`);
          await printOrder(order);
        }
      }
    } else {
      log(`${time}: No new orders`);
    }
  } catch (error) {
    const status = error.response?.status;
    const errorMsg = error.response?.data?.message || error.message;
    log(`Failed to fetch orders: ${status || "Unknown"} - ${errorMsg}`);
    if (status === 401 || status === 403) {
      log("Token expired, attempting re-login...");
      encryptedJwtToken = null;
      const loginSuccess = await autoLogin();
      if (loginSuccess) {
        log("Re-login successful, resuming polling");
        await pollOrders();
      } else {
        log("Re-login failed after max attempts, exiting...");
        process.exit(1);
      }
    } else {
      log("Non-authentication error, continuing polling...");
    }
  }
}

// 초기화
async function init() {
  try {
    const creds = await getCredentials();
    log("Credentials found, proceeding with auto-login...");
    const loginSuccess = await autoLogin();
    if (!loginSuccess) {
      throw new Error("Initial login failed after max attempts");
    }
  } catch (error) {
    log("Credentials not found. Please provide username and password to save.");
    const [,, username, password] = process.argv;
    if (!username || !password) {
      log("Usage: node print-agent.js <username> <password> (for first-time setup)");
      process.exit(1);
    }
    await saveCredentials(username, password);
    const loginSuccess = await autoLogin();
    if (!loginSuccess) {
      log("Initial login failed after max attempts, exiting...");
      process.exit(1);
    }
  }
  await initializePrinter();
  if (!encryptedJwtToken) {
    log("Failed to obtain token, exiting...");
    process.exit(1);
  }
}

// 서버 시작
init().then(() => {
  log(`Starting server on port ${PORT}`);
  pollOrders();
  pollingInterval = setInterval(pollOrders, 3000);
  server.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
  });
});

// 프로세스 종료 시
process.on("SIGINT", async () => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    log("Polling stopped");
  }
  if (printer) {
    try {
      await new Promise((resolve, reject) => {
        printer.flush((err) => {
          if (err) {
            log(`Failed to flush printer buffer on shutdown: ${err.message}`);
            reject(err);
          } else {
            printer.close(() => {
              log("Printer closed successfully");
              resolve();
            });
          }
        });
      });
    } catch (error) {
      log(`Error closing printer: ${error.message}`);
    }
  }
  log("Server shutdown complete");
  process.exit();
});