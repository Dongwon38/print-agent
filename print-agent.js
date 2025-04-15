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

// 프린터 설정
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

let JWT_TOKEN = null;
let pollingInterval = null;

// 프린터 초기화
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

// 로그 출력
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

// 글자 수 계산 (중국어 2칸)
function calculateTextLength(text) {
  let length = 0;
  for (const char of text) {
    if (/[\u4E00-\u9FFF]/.test(char)) {
      length += 2; // 중국어는 2칸
    } else {
      length += 1; // 영어 및 기타는 1칸
    }
  }
  log(`Text: "${text}", Calculated Length: ${length}`);
  return length;
}

// 가격 포맷팅 함수
function formatPrice(price) {
  const priceStr = price.toString();
  const priceLength = priceStr.length;
  let padding;
  if (priceLength === 4) padding = 4; // "0.00" → "    0.00"
  else if (priceLength === 5) padding = 3; // "17.45" → "   17.45"
  else padding = 2; // "123.45" → "  123.45"
  const formatted = " ".repeat(padding) + priceStr;
  log(`Formatted Price: "${priceStr}" → "${formatted}"`);
  return formatted;
}

// wrapTextWithPrice 함수 (여백 조정)
function wrapTextWithPrice(text, prefix, price) {
  const lines = [];
  const priceText = formatPrice(price);
  const priceLength = priceText.length;
  const prefixLength = calculateTextLength(prefix);

  // 첫째 줄 가능 길이 계산 (여백 2칸 포함)
  const firstLineAvailableWidth =
    MAX_LINE_CHARS - prefixLength - priceLength - 2;
  // 이후 줄 가능 길이 (여백 2칸 포함)
  const subsequentLineAvailableWidth = MAX_LINE_CHARS - priceLength - 2;

  let currentLine = "";
  let currentLineLength = 0;
  let isFirstLine = true;

  for (const char of text) {
    const charLength = /[\u4E00-\u9FFF]/.test(char) ? 2 : 1;
    const availableWidth = isFirstLine
      ? firstLineAvailableWidth
      : subsequentLineAvailableWidth;

    if (currentLineLength + charLength <= availableWidth) {
      currentLine += char;
      currentLineLength += charLength;
    } else {
      if (currentLine) {
        // 실제 출력 줄 구성: prefix + 텍스트 + 여백(1~2칸) + 가격
        const actualLine = isFirstLine ? prefix + currentLine : currentLine;
        const actualLineLength = calculateTextLength(actualLine);
        const remainingSpace = MAX_LINE_CHARS - actualLineLength - priceLength;
        const spaces = " ".repeat(Math.max(1, Math.min(2, remainingSpace))); // 1~2칸 여백
        const line = actualLine + spaces + priceText;
        lines.push(line);
        log(
          `WrapTextWithPrice - ${
            isFirstLine ? "Line 1" : "Wrapped Line"
          }: "${line}"`
        );
        log(
          `Actual Line Length: ${actualLineLength}, Spaces: ${spaces.length}, Price Length: ${priceLength}`
        );

        isFirstLine = false;
        currentLine = char;
        currentLineLength = charLength;
      } else {
        currentLine = char;
        currentLineLength = charLength;
      }
    }
  }

  if (currentLine) {
    const actualLine = isFirstLine ? prefix + currentLine : currentLine;
    const actualLineLength = calculateTextLength(actualLine);
    const remainingSpace = MAX_LINE_CHARS - actualLineLength - priceLength;
    const spaces = " ".repeat(Math.max(1, Math.min(2, remainingSpace))); // 1~2칸 여백
    const line = actualLine + spaces + priceText;
    lines.push(line);
    log(
      `WrapTextWithPrice - ${
        isFirstLine ? "Line 1" : "Wrapped Line"
      }: "${line}"`
    );
    log(
      `Actual Line Length: ${actualLineLength}, Spaces: ${spaces.length}, Price Length: ${priceLength}`
    );
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
        log(`WrapText - Wrapped Line: "${currentLine}"`);
      }
      currentLine = char;
      currentLineLength = charLength;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
    log(`WrapText - Line: "${currentLine}"`);
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
    // order.cart 파싱
    let cart = [];
    if (order.cart) {
      try {
        cart = JSON.parse(order.cart);
      } catch (e) {
        log(
          `Error parsing cart for order #${order.order_number}: ${e.message}`
        );
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
    printer.raw(Buffer.from([0x1b, 0x40])); // 프린터 초기화

    // 고객 정보
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
      printer.text("Customer Notes:");
      wrapText(order.customer_notes, MAX_LINE_CHARS - 2).forEach((line) =>
        printer.text(`  ${line}`)
      );
    }
    printer.text("-".repeat(MAX_LINE_CHARS));

    // 아이템 목록
    if (items.length === 0) {
      printer.text("No items in this order.");
    } else {
      items.forEach((item, index) => {
        const itemSubtotal = Number(
          item.subtotal ||
            (item.basePrice || item.price) * (item.quantity || 1) ||
            0
        ).toFixed(2);
        const itemName = `${item.quantity || 1} x ${
          item.name || item.item_name || "Unknown"
        }`;
        const prefix = `${item.quantity || 1} x `;

        const lines = wrapTextWithPrice(
          itemName.slice(prefix.length),
          prefix,
          itemSubtotal
        );
        lines.forEach((line) => printer.text(line));

        // 옵션 출력
        if (item.options && item.options.length > 0) {
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              let optionText = `${choice.name || "N/A"}`;
              let totalPrice = Number(
                choice.extraPrice ||
                  choice.additional_price ||
                  choice.price ||
                  0
              );

              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    const subPrice = Number(
                      subChoice.extraPrice ||
                        subChoice.additional_price ||
                        subChoice.price ||
                        0
                    );
                    totalPrice = Number(totalPrice) + Number(subPrice);
                    optionText += ` (${subChoice.name || "N/A"})`;
                  });
                });
              }

              totalPrice = totalPrice.toFixed(2);
              const optionPrefix = "- ";
              const optionLines = wrapTextWithPrice(
                optionText,
                optionPrefix,
                totalPrice
              );
              optionLines.forEach((line) => printer.text(line));
            });
          });
        }

        // 특이사항
        if (item.specialInstructions) {
          printer.text("- Note: ");
          wrapText(item.specialInstructions, MAX_LINE_CHARS - 2).forEach(
            (line) => printer.text(`  ${line}`)
          );
        }

        if (index < items.length - 1) {
          printer.text("-".repeat(MAX_LINE_CHARS));
        }
      });
    }

    // 총액
    printer
      .text("-".repeat(MAX_LINE_CHARS))
      .align("RT")
      .size(0, 0)
      .text(`Subtotal: ${formatPrice(subtotal.toFixed(2))}`)
      .text(`GST (5%): ${formatPrice(gst.toFixed(2))}`)
      .text(`Tip: ${formatPrice(tip.toFixed(2))}`)
      .size(1, 1)
      .text(`TOTAL: ${formatPrice(total.toFixed(2))}`)
      .size(0, 0);

    // 푸터
    printer
      .align("CT")
      .text("Thank you for your order!")
      .text("Night Owl Cafe")
      .text("#104-8580 Cambie Rd, Richmond, BC")
      .text("(604) 276-0576")
      .text(`GST Number: ${GSTNumber}`)
      .feed(3);

    // 고객용 영수증 커팅 및 버퍼 플러시
    printer.cut();
    await new Promise((resolve, reject) => {
      printer.flush((err) => {
        if (err) {
          log(
            "Failed to flush printer buffer for customer receipt: " +
              err.message
          );
          reject(err);
        } else {
          log("Printer buffer flushed successfully for customer receipt");
          resolve();
        }
      });
    });

    // 2. 주방용 영수증 출력 (메뉴 단위로)
    if (items.length === 0) {
    } else {
      items.forEach((item, itemIndex) => {
        printer.raw(Buffer.from([0x1b, 0x40])); // 프린터 초기화

        // 고객 정보 및 픽업 시간
        printer
          .align("LT")
          .size(1, 1)
          .text(`${customerName}(${shortOrderNumber})`)
          .size(0, 0)
          .text(`PICKUP at ${pickupTimeShort}, ${pickupDateShort}`)
          .text("-".repeat(MAX_LINE_CHARS));

        // 아이템 이름 (중문 추출)
        const itemName = `${item.quantity || 1} x ${extractChineseText(
          item.name || item.item_name || "Unknown"
        )}`;
        printer.size(1, 1);
        wrapText(itemName, MAX_LINE_CHARS).forEach((line) =>
          printer.text(line)
        );

        // 옵션
        if (item.options && item.options.length > 0) {
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              let optionText = `- ${extractChineseText(choice.name || "N/A")}`;
              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    optionText += ` (${extractChineseText(
                      subChoice.name || "N/A"
                    )})`;
                  });
                });
              }
              wrapText(optionText, MAX_LINE_CHARS).forEach((line) =>
                printer.size(0, 0).text("\n").size(1, 1).text(line)
              );
            });
          });
        }

        // 특이사항
        if (item.specialInstructions) {
          printer.size(1, 1);
          printer.text("- Note: ");
          wrapText(item.specialInstructions, MAX_LINE_CHARS - 2).forEach(
            (line) => printer.text(`  ${line}`)
          );
        }

        // 주방용 영수증 마무리
        printer.size(0, 0).feed(2);

        // 커팅 및 버퍼 플러시
        printer.cut();
        printer.flush();
      });
    }

    // print_status 업데이트
    try {
      await axios.post(
        `${API_URL}/update-print-status`,
        { order_id: order.id, print_status: "printed" },
        { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
      );
      log(`Marked order #${order.id} as printed`);
    } catch (error) {
      log(
        `Failed to update print status for order #${order.id}: ${error.message}`
      );
    }

    log(`Order #${orderNumber} printed successfully`);
  } catch (error) {
    log(
      `Error printing order #${order.order_number || "N/A"}: ${error.message}`
    );
  }
}

// API 폴링
async function pollOrders() {
  if (!JWT_TOKEN) {
    io.emit("relogin", "Session expired, please re-login.");
    return;
  }

  try {
    const response = await axios.get(`${API_URL}/pending-orders`, {
      headers: { Cookie: `jwt_token=${JWT_TOKEN}` },
    });
    const orders = response.data || [];

    if (orders.length > 0) {
      for (const order of orders) {
        if (!order.print_status && order.payment_status === "paid") {
          await printOrder(order);
        }
      }
    }
  } catch (error) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
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
    res.json({ status: "success", message: "Logged in" });
  } catch (error) {
    res.status(401).json({ status: "error", message: "Login failed" });
  }
});

app.get("/start", async (req, res) => {
  if (!JWT_TOKEN) {
    return res
      .status(401)
      .json({ status: "error", message: "Not authenticated" });
  }
  if (!pollingInterval) {
    pollOrders();
    pollingInterval = setInterval(pollOrders, 3000);
    updateStatus("Running");
    res.json({ status: "started" });
  } else {
    res.json({ status: "already_running" });
  }
});

app.get("/stop", (req, res) => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    updateStatus("Stopped");
    res.json({ status: "stopped" });
  } else {
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
    }
  } catch (error) {
    process.exit(1);
  }
}

// WebSocket 연결
io.on("connection", (socket) => {
  socket.on("disconnect", () => {});
});

// 서버 시작
init().then(() => {
  server.listen(PORT, () => {});
});

// 프로세스 종료 시 프린터 닫기
process.on("SIGINT", async () => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  if (printer) {
    await new Promise((resolve) => {
      printer.flush(() => {
        printer.close(() => {
          resolve();
        });
      });
    });
  }
  process.exit();
});
