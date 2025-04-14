const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const axios = require("axios");
const fs = require("fs").promises;
const escpos = require("escpos");
escpos.USB = require("escpos-usb");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Printer Settings
const devices = escpos.USB.findPrinter();
if (devices.length === 0) {
  console.log("No USB printer found");
  process.exit();
}

const device = new escpos.USB(
  devices[0].deviceDescriptor.idVendor,
  devices[0].deviceDescriptor.idProduct
);
const options = { encoding: "GB18030" };
let printer = null;

const API_URL = process.env.API_URL;
const PORT = process.env.PORT || 3000;
const TOKEN_FILE = "./jwt_token.txt";
const GSTNumber = "872046354";
const MAX_LINE_CHARS = 48;
const PRICE_WIDTH = 8; // 가격란은 항상 8칸 (공백 2칸 + "000.00")

let JWT_TOKEN = null;
let pollingInterval = null;

// Reset printer
async function initializePrinter() {
  return new Promise((resolve, reject) => {
    device.open((error) => {
      if (error) {
        reject(error);
      } else {
        printer = new escpos.Printer(device, options);
        log("Printer initialized successfully");
        resolve();
      }
    });
  });
}

// 로그 출력 및 클라이언트로 전송
function log(message) {
  const timestamp = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/Vancouver",
  });
  console.log(`[${timestamp}] ${message}`);
  io.emit("log", message);
}

// 상태 업데이트
function updateStatus(status) {
  io.emit("status", status);
}

// 텍스트 길이 계산 (영어 1칸, 중국어 2칸)
function calculateTextLength(text) {
  let length = 0;
  for (const char of text) {
    if (/[\u4E00-\u9FFF]/.test(char)) {
      length += 2; // 중국어는 2칸
    } else {
      length += 1; // 영어 및 기타는 1칸
    }
  }
  return length;
}

// wrapTextWithPrice 함수 (줄바꿈 시 가격란 비워두기)
function wrapTextWithPrice(text, price, prefixLength = 0) {
  const lines = [];
  const priceText = price.toString().padStart(5, " "); // "  00.00" 형식
  const maxTextWidth = MAX_LINE_CHARS - PRICE_WIDTH - prefixLength; // 가격란 제외한 최대 텍스트 길이
  const priceLineWidth = MAX_LINE_CHARS - PRICE_WIDTH; // 가격란 제외한 줄 길이

  let currentLine = "";
  let currentLineLength = 0;
  let isFirstLine = true;

  for (const char of text) {
    const charLength = /[\u4E00-\u9FFF]/.test(char) ? 2 : 1;
    if (currentLineLength + charLength <= maxTextWidth) {
      currentLine += char;
      currentLineLength += charLength;
    } else {
      if (currentLine) {
        if (isFirstLine) {
          lines.push(currentLine.padEnd(priceLineWidth, " ") + priceText);
          isFirstLine = false;
        } else {
          lines.push(currentLine.padEnd(priceLineWidth, " "));
        }
        currentLine = char;
        currentLineLength = charLength;
      }
    }
  }

  if (currentLine) {
    if (isFirstLine) {
      lines.push(currentLine.padEnd(priceLineWidth, " ") + priceText);
    } else {
      lines.push(currentLine.padEnd(priceLineWidth, " "));
    }
  }

  return lines;
}

// wrapText 함수 (자수 계산 반영)
function wrapText(text, maxWidth, addSpacing = false, prefixLength = 0) {
  const lines = [];
  let currentLine = "";
  let currentLineLength = 0;
  const effectiveMaxWidth = maxWidth - prefixLength;

  for (const char of text) {
    const charLength = /[\u4E00-\u9FFF]/.test(char) ? 2 : 1;
    if (currentLineLength + charLength <= effectiveMaxWidth) {
      currentLine += char;
      currentLineLength += charLength;
    } else {
      if (currentLine) {
        lines.push(currentLine.padEnd(effectiveMaxWidth, " "));
        currentLine = char;
        currentLineLength = charLength;
      }
    }
  }

  if (currentLine) {
    lines.push(currentLine.padEnd(effectiveMaxWidth, " "));
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

// 동적 데이터로 영수증 출력
async function printOrder(order) {
  try {
    log("Received order data: " + JSON.stringify(order, null, 2));

    // order.cart 파싱
    let cart = [];
    if (order.cart) {
      try {
        cart = JSON.parse(order.cart);
      } catch (e) {
        log(`Error parsing cart for order #${order.order_number}: ${e.message}`);
        return;
      }
    }

    // 주문 데이터 파싱 및 기본값 설정
    const customerName = order.customer_name || "Unknown";
    const orderNumber = order.order_number || "N/A";
    const shortOrderNumber = orderNumber.split("-")[1] || "N/A";
    const pickupTime = order.due_at
      ? new Date(order.due_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/Vancouver",
        })
      : "N/A";
    const pickupTimeShort = order.due_at
      ? new Date(order.due_at).toLocaleString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/Vancouver",
        })
      : "N/A";
    const pickupDateShort = order.due_at
      ? new Date(order.due_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "America/Vancouver",
        })
      : "N/A";
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
    const items = cart || [];
    const subtotal = Number(order.subtotal || 0);
    const gst = Number(order.gst || 0);
    const tip = Number(order.tip || 0);
    const total = Number(order.total || 0);

    // 1. 고객용 영수증 출력
    log("Printing customer receipt...");

    // 프린터 초기화 명령
    log("Sending printer initialization command for customer receipt...");
    printer.raw(Buffer.from([0x1B, 0x40])); // 프린터 초기화

    // 고객 정보
    log("Printing customer info...");
    printer
      .font("a")
      .align("LT")
      .style("NORMAL")
      .size(1, 1)
      .text(`${customerName}(${shortOrderNumber})`)
      .size(0, 0)
      .text(`PICKUP at ${pickupTime}`)
      .text(`Order at ${orderTime}`)
      .text(`Phone: ${phone}`);

    if (order.customer_notes) {
      log("Printing customer notes...");
      printer.text("Customer Notes:");
      wrapText(order.customer_notes, MAX_LINE_CHARS, false, 2).forEach((line) =>
        printer.text(`  ${line}`)
      );
    }
    printer.text("------------------------------------------------");

    // 아이템 목록
    if (items.length === 0) {
      log("No items in this order");
      printer.text("No items in this order.");
    } else {
      log("Printing items...");
      items.forEach((item, index) => {
        const itemSubtotal = Number(
          item.subtotal || (item.basePrice || item.price) * (item.quantity || 1) || 0
        ).toFixed(2);
        const itemName = `${item.quantity || 1} x ${item.name || item.item_name || "Unknown"}`;
        const lines = wrapTextWithPrice(itemName, itemSubtotal, 4); // "1 x " = 4칸
        lines.forEach((line) => printer.text(line));

        // 옵션 출력
        if (item.options && item.options.length > 0) {
          log("Printing options...");
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              const optionText = `- ${choice.name || "N/A"}`;
              let totalPrice = Number(
                choice.extraPrice || choice.additional_price || choice.price || 0
              ).toFixed(2);
              const optionLines = wrapTextWithPrice(optionText, totalPrice, 2); // "- " = 2칸
              optionLines.forEach((line) => printer.text(line));

              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    const subOptionText = ` - ${subChoice.name || "N/A"}`;
                    const subPrice = Number(
                      subChoice.extraPrice || subChoice.additional_price || subChoice.price || 0
                    ).toFixed(2);
                    totalPrice = (Number(totalPrice) + Number(subPrice)).toFixed(2);
                    const subOptionLines = wrapTextWithPrice(subOptionText, subPrice, 3); // " - " = 3칸
                    subOptionLines.forEach((line) => printer.text(line));
                  });
                });
              }
            });
          });
        }

        // 특이사항
        if (item.specialInstructions) {
          log("Printing special instructions...");
          printer.text("- Note: ");
          wrapText(item.specialInstructions, MAX_LINE_CHARS, false, 2).forEach((line) =>
            printer.text(`  ${line}`)
          );
        }

        if (index < items.length - 1) {
          printer.text("------------------------------------------------");
        }
      });
    }

    // 총액
    log("Printing totals...");
    printer.text("------------------------------------------------");
    printer.align("LT");
    printer.text("Subtotal:".padEnd(MAX_LINE_CHARS - PRICE_WIDTH, " ") + subtotal.toFixed(2).padStart(5, " "));
    printer.text("GST (5%):".padEnd(MAX_LINE_CHARS - PRICE_WIDTH, " ") + gst.toFixed(2).padStart(5, " "));
    printer.text("Tip:".padEnd(MAX_LINE_CHARS - PRICE_WIDTH, " ") + tip.toFixed(2).padStart(5, " "));
    printer.size(1, 1);
    printer.text("TOTAL:".padEnd(MAX_LINE_CHARS - PRICE_WIDTH, " ") + total.toFixed(2).padStart(5, " "));
    printer.size(0, 0);

    // 푸터
    log("Printing footer...");
    printer
      .align("CT")
      .text("Thank you for your order!")
      .text("Night Owl Cafe")
      .text("#104-8580 Cambie Rd, Richmond, BC")
      .text("(604) 276-0576")
      .text(`GST Number: ${GSTNumber}`)
      .feed(3);

    // 고객용 영수증 커팅 및 버퍼 플러시
    log("Sending cut command for customer receipt...");
    printer.cut();

    log("Flushing printer buffer for customer receipt...");
    await new Promise((resolve, reject) => {
      printer.flush((err) => {
        if (err) {
          log("Failed to flush printer buffer for customer receipt: " + err.message);
          reject(err);
        } else {
          log("Printer buffer flushed successfully for customer receipt");
          resolve();
        }
      });
    });

    // 2. 주방용 영수증 출력 (메뉴 단위로)
    log("Printing kitchen receipt...");
    if (items.length === 0) {
      log("No items to print for kitchen receipt");
    } else {
      items.forEach((item, itemIndex) => {
        log(`Printing kitchen receipt for item ${itemIndex + 1}...`);

        // 프린터 초기화
        log("Sending printer initialization command for kitchen receipt...");
        printer.raw(Buffer.from([0x1B, 0x40])); // 프린터 초기화

        // 고객 정보 및 픽업 시간
        printer
          .align("LT")
          .size(1, 1)
          .text(`${customerName}(${shortOrderNumber})`)
          .size(0, 0)
          .text(`PICKUP at ${pickupTimeShort}, ${pickupDateShort}`)
          .text("------------------------------------------------");

        // 아이템 이름 (중문 추출)
        const itemName = `${item.quantity || 1} x ${extractChineseText(item.name || item.item_name || "Unknown")}`;
        printer.size(1, 1);
        wrapText(itemName, MAX_LINE_CHARS, false, 4).forEach((line) =>
          printer.text(line)
        );

        // 옵션
        if (item.options && item.options.length > 0) {
          log("Printing kitchen options...");
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              const optionText = `- ${extractChineseText(choice.name || "N/A")}`;
              printer.size(1, 1);
              wrapText(optionText, MAX_LINE_CHARS, true, 2).forEach((line) =>
                printer.text(line)
              );

              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    const subOptionText = ` - ${extractChineseText(subChoice.name || "N/A")}`;
                    printer.size(1, 1);
                    wrapText(subOptionText, MAX_LINE_CHARS, true, 3).forEach((line) =>
                      printer.text(line)
                    );
                  });
                });
              }
            });
          });
        }

        // 특이사항
        if (item.specialInstructions) {
          log("Printing kitchen special instructions...");
          printer.size(1, 1);
          printer.text("- Note: ");
          wrapText(item.specialInstructions, MAX_LINE_CHARS, false, 2).forEach((line) =>
            printer.text(`  ${line}`)
          );
        }

        // 주방용 영수증 마무리
        printer.size(0, 0).feed(2);

        // 커팅 및 버퍼 플러시
        log(`Sending cut command for kitchen receipt item ${itemIndex + 1}...`);
        printer.cut();

        log(`Flushing printer buffer for kitchen receipt item ${itemIndex + 1}...`);
        printer.flush((err) => {
          if (err) {
            log(`Failed to flush printer buffer for kitchen receipt item ${itemIndex + 1}: ${err.message}`);
          } else {
            log(`Printer buffer flushed successfully for kitchen receipt item ${itemIndex + 1}`);
          }
        });
      });
    }

    // print_status 업데이트
    log("Updating print status...");
    try {
      await axios.post(
        `${API_URL}/update-print-status`,
        { order_id: order.id, print_status: "printed" },
        { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
      );
      log(`Marked order #${order.id} as printed`);
    } catch (error) {
      log(`Failed to update print status for order #${order.id}: ${error.message}`);
    }

    log(`Order #${orderNumber} printed successfully`);
  } catch (error) {
    log(`Error printing order #${order.order_number || "N/A"}: ${error.message}`);
  }
}

// API 폴링
async function pollOrders() {
  if (!JWT_TOKEN) {
    log("No token available, please login first.");
    io.emit("relogin", "Session expired, please re-login.");
    return;
  }

  try {
    log("Polling for new orders...");
    const response = await axios.get(`${API_URL}/pending-orders`, {
      headers: { Cookie: `jwt_token=${JWT_TOKEN}` },
    });
    const orders = response.data || [];
    const time = new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    });

    if (orders.length > 0) {
      log(`Found ${orders.length} new orders`);
      for (const order of orders) {
        if (!order.print_status && order.payment_status === "paid") {
          log(`Order #${order.order_number || "N/A"} detected, printing...`);
          await printOrder(order);
        } else {
          log(`Order #${order.order_number || "N/A"} already printed or not paid`);
        }
      }
    } else {
      log(`${time}: No new orders found.`);
    }
  } catch (error) {
    const status = error.response?.status;
    const errorMsg = error.response?.data?.message || error.message;
    log(`Polling error: ${status || "Unknown"} - ${errorMsg}`);
    if (status === 401 || status === 403) {
      log("Token expired or invalid, please re-login.");
      JWT_TOKEN = null;
      clearInterval(pollingInterval);
      pollingInterval = null;
      updateStatus("Stopped");
      io.emit("relogin", "Session expired, please re-login.");
    }
    io.emit("error", "Failed to fetch orders");
  }
}

// Express 라우팅
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const response = await axios.post(
      `${API_URL}/login`,
      { username, password },
      { headers: { "Content-Type": "application/json" }, withCredentials: true }
    );
    JWT_TOKEN = response.data.token;
    await fs.writeFile(TOKEN_FILE, JWT_TOKEN);
    log("Login successful");
    res.json({ status: "success", message: "Logged in" });
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    log(`Login error: ${errorMsg}`);
    res.status(401).json({ status: "error", message: "Login failed" });
  }
});

app.get("/start", async (req, res) => {
  if (!JWT_TOKEN) {
    log("Please login first");
    return res
      .status(401)
      .json({ status: "error", message: "Not authenticated" });
  }
  if (!pollingInterval) {
    log("Starting server...");
    pollOrders();
    pollingInterval = setInterval(pollOrders, 3000);
    updateStatus("Running");
    res.json({ status: "started" });
  } else {
    log("Server already running.");
    res.json({ status: "already_running" });
  }
});

app.get("/stop", (req, res) => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    log("Server stopped.");
    updateStatus("Stopped");
    res.json({ status: "stopped" });
  } else {
    log("Server not running.");
    res.json({ status: "not_running" });
  }
});

// 초기화
async function init() {
  try {
    await initializePrinter();
    if (
      await fs
        .access(TOKEN_FILE)
        .then(() => true)
        .catch(() => false)
    ) {
      JWT_TOKEN = await fs.readFile(TOKEN_FILE, "utf8");
      log("Loaded saved token");
    } else {
      log("No saved token found, please login.");
    }
  } catch (error) {
    log(`Error during initialization: ${error.message}`);
    process.exit(1);
  }
}

// WebSocket 연결
io.on("connection", (socket) => {
  log("Client connected to WebSocket");
  socket.on("disconnect", () => log("Client disconnected"));
});

// 서버 시작
init().then(() => {
  server.listen(PORT, () => {
    log(`Server running on http://localhost:${PORT}`);
    updateStatus(pollingInterval ? "Running" : "Stopped");
  });
});

// 프로세스 종료 시 프린터 닫기
process.on("SIGINT", async () => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    log("Polling stopped.");
  }
  if (printer) {
    log("Flushing printer buffer before closing...");
    await new Promise((resolve, reject) => {
      printer.flush((err) => {
        if (err) {
          log("Failed to flush printer buffer: " + err.message);
          reject(err);
        } else {
          log("Printer buffer flushed successfully");
          resolve();
        }
      });
    });

    log("Closing printer...");
    await new Promise((resolve) => {
      printer.close(() => {
        log("Printer closed");
        resolve();
      });
    });
  }
  log("Exiting process...");
  process.exit();
});