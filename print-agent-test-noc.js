// 250417, 로그인 테스트까지 끝난 버전, NOC에 직접 가서 테스트 해야 하는 버전
// node print-agent.js USERNAME PASSWORD, 백엔드에서 설정한 로그인 유효기간 = 30 days


const express = require("express");
const http = require("http");
const axios = require("axios");
const escpos = require("escpos");
const { SerialPort } = require("serialport");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const API_URL = process.env.NOC_API_URL;
const PORT = process.env.PORT || 3000;
const GSTNumber = "872046354";
const MAX_LINE_CHARS = 48;

let JWT_TOKEN = null;
let pollingInterval = null;

// 시리얼 포트와 프린터 초기화 (기본적으로 열지 않음)
const serialPort = new SerialPort({ path: "COM1", baudRate: 9600, autoOpen: false });
const printer = new escpos.Printer(serialPort, { encoding: "GB18030" });

serialPort.on("error", (err) => {
  log(`Serial port error: ${err.message}`);
});

// 커맨드 라인 인자 처리
const [,, username, password] = process.argv; // node print-agent.js username password

if (!username || !password) {
  console.error("Usage: node print-agent.js <username> <password>");
  process.exit(1);
}

// 로그 파일로 출력
function log(message) {
  const timestamp = new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" });
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage);
  require("fs").appendFile("server.log", logMessage, (err) => {
    if (err) console.error(`Failed to write log: ${err.message}`);
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

// wrapTextWithPrice 함수
function wrapTextWithPrice(text, prefix, price) {
  const lines = [];
  const priceText = Number(price).toFixed(2);
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
      if (isFirstLine) {
        const spaces = " ".repeat(MAX_LINE_CHARS - (prefixLength + currentLineLength + priceLength));
        line = prefix + currentLine + spaces + priceText;
        isFirstLine = false;
      } else {
        const spaces = " ".repeat(MAX_LINE_CHARS - currentLineLength);
        line = currentLine + spaces;
      }
      lines.push(line);

      currentLine = char;
      currentLineLength = charLength;
    }
  }

  if (currentLine) {
    let line;
    if (isFirstLine) {
      const spaces = " ".repeat(MAX_LINE_CHARS - (prefixLength + currentLineLength + priceLength));
      line = prefix + currentLine + spaces + priceText;
    } else {
      const spaces = " ".repeat(MAX_LINE_CHARS - currentLineLength);
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
    .text(`Subtotal: ${subtotal.toFixed(2).padStart(7)}`)
    .text(`GST (5%): ${gst.toFixed(2).padStart(7)}`)
    .text(`Tip: ${tip.toFixed(2).padStart(7)}`)
    .size(1, 1)
    .text(`TOTAL: ${total.toFixed(2).padStart(7)}`)
    .size(0, 0);

  printer
    .align("CT")
    .text("")
    .text("Thank you for your order!")
    .text("Night Owl Cafe")
    .text("#104-8580 Cambie Rd, Richmond, BC")
    .text("(604) 276-0576")
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

    await new Promise((resolve, reject) => {
      if (serialPort.isOpen) {
        resolve();
      } else {
        serialPort.open((err) => {
          if (err) {
            log(`Failed to open serial port: ${err.message}`);
            reject(err);
          } else {
            log("Serial port connected successfully");
            resolve();
          }
        });
      }
    });

    await printCustomerReceipt(order, false);
    await printCustomerReceipt(order, true);
    await printKitchenReceipt(order);

    try {
      await axios.post(
        `${API_URL}/update-print-status`,
        { order_id: order.id, print_status: "printed" },
        { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
      );
    } catch (error) {
      log(`Failed to update print status for order #${order.id}: ${error.message}`);
      return;
    }

    log(`Order #${order.order_number} printed successfully`);
  } catch (error) {
    log(`Error printing order #${order.order_number || "N/A"}: ${error.message}`);
  } finally {
    if (serialPort.isOpen) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        printer.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await new Promise((resolve, reject) => {
          serialPort.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        log("Serial port closed successfully");
      } catch (error) {
        log(`Error closing serial port: ${error.message}`);
      }
    }
  }
}

// 자동 로그인 및 토큰 갱신
async function autoLogin() {
  if (!username || !password) {
    log("Username or password missing from command line arguments");
    process.exit(1);
  }

  try {
    log("Attempting auto-login...");
    const response = await axios.post(
      `${API_URL}/login`,
      { username, password },
      { headers: { "Content-Type": "application/json" }, withCredentials: true }
    );
    JWT_TOKEN = response.data.token;
    log(`Auto-login successful, JWT_TOKEN: ${JWT_TOKEN}`);
  } catch (error) {
    log(`Auto-login failed: ${error.response?.data?.message || error.message}`);
    process.exit(1);
  }
}

// API 폴링
async function pollOrders() {
  if (!JWT_TOKEN) {
    await autoLogin();
    if (!JWT_TOKEN) return;
  }

  try {
    const response = await axios.get(`${API_URL}/pending-orders`, {
      headers: { Cookie: `jwt_token=${JWT_TOKEN}` },
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
      JWT_TOKEN = null;
      await autoLogin();
      if (JWT_TOKEN) {
        log("Re-login successful, resuming polling");
      } else {
        log("Re-login failed, exiting...");
        process.exit(1);
      }
    }
  }
}

// 초기화
async function init() {
  if (!username || !password) {
    log("Required username and password are missing from command line arguments");
    process.exit(1);
  }

  await autoLogin();
  if (!JWT_TOKEN) {
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
  if (serialPort.isOpen) {
    try {
      printer.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve, reject) => {
        serialPort.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log("Serial port closed successfully");
    } catch (error) {
      log(`Error closing serial port: ${error.message}`);
    }
  }
  log("Server shutdown complete");
  process.exit();
});