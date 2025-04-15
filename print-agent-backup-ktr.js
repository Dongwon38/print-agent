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
  process.exit(1);
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
const GSTNumber = "TESTNUMBER";
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
        log("Printer connected successfully");
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

// wrapTextWithPrice 함수
function wrapTextWithPrice(text, maxWidth, price) {
  const lines = [];
  const priceText = price.toString();
  const availableWidth = maxWidth - priceText.length - 2;

  let currentLine = "";
  const words = text.split(" ");
  let isFirstLine = true;

  words.forEach((word) => {
    if ((currentLine + " " + word).length <= availableWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) {
        if (isFirstLine) {
          lines.push(
            currentLine.padEnd(maxWidth - priceText.length) + priceText
          );
          isFirstLine = false;
        } else {
          lines.push(currentLine);
        }
        currentLine = word.length <= maxWidth ? word : word.slice(0, maxWidth);
      } else {
        currentLine = word.length <= maxWidth ? word : word.slice(0, maxWidth);
      }
    }
  });

  if (currentLine) {
    if (isFirstLine) {
      lines.push(currentLine.padEnd(maxWidth - priceText.length) + priceText);
    } else {
      lines.push(currentLine);
    }
  }

  return lines;
}

// wrapText 함수
function wrapText(text, maxWidth, addSpacing = false) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  words.forEach((word) => {
    if ((currentLine + " " + word).length <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length <= maxWidth ? word : word.slice(0, maxWidth);
    }
  });
  if (currentLine) lines.push(currentLine);

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
        log(`Failed to parse cart for order #${order.order_number}: ${e.message}`);
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
      wrapText(order.customer_notes, MAX_LINE_CHARS).forEach((line) =>
        printer.text(`  ${line}`)
      );
    }
    printer.text("------------------------------------------------");

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
        const priceText = itemSubtotal.padStart(5, " ");

        const itemNameLength =
          (item.name || item.item_name || "Unknown").length + 3;
        if (itemNameLength > 43) {
          const lines = wrapTextWithPrice(itemName, MAX_LINE_CHARS, priceText);
          lines.forEach((line) => printer.text(line));
        } else {
          const spaceLength = 48 - itemNameLength - 8;
          const spaces = " ".repeat(Math.max(0, spaceLength));
          printer.text(`${itemName}${spaces}${priceText}`);
        }

        // 옵션 출력
        if (item.options && item.options.length > 0) {
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              let optionText = `- ${choice.name || "N/A"}`;
              let totalPrice = Number(
                choice.extraPrice ||
                  choice.additional_price ||
                  choice.price ||
                  0
              ).toFixed(2);

              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    const subPrice = Number(
                      subChoice.extraPrice ||
                        subChoice.additional_price ||
                        subChoice.price ||
                        0
                    ).toFixed(2);
                    totalPrice = (
                      Number(totalPrice) + Number(subPrice)
                    ).toFixed(2);
                    optionText += `(${subChoice.name || "N/A"})`;
                  });
                });
              }

              const priceTextOption = totalPrice.padStart(4, " ");
              const optionNameLength = (optionText || "N/A").length + 3;
              if (optionNameLength > 44) {
                const optionLines = wrapTextWithPrice(
                  optionText,
                  MAX_LINE_CHARS,
                  priceTextOption
                );
                optionLines.forEach((line) => printer.text(line));
              } else {
                const spaceLength = 48 - optionNameLength - 6;
                const spaces = " ".repeat(Math.max(0, spaceLength));
                printer.text(`${optionText}${spaces}${priceTextOption}`);
              }
            });
          });
        }

        // 특이사항
        if (item.specialInstructions) {
          printer.text("- Note: ");
          wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach((line) =>
            printer.text(`  ${line}`)
          );
        }

        if (index < items.length - 1) {
          printer.text("------------------------------------------------");
        }
      });
    }

    // 총액
    printer
      .text("------------------------------------------------")
      .align("RT")
      .size(0, 0)
      .text(`Subtotal: ${subtotal.toFixed(2)}`)
      .text(`GST (5%): ${gst.toFixed(2)}`)
      .text(`Tip: ${tip.toFixed(2)}`)
      .size(1, 1)
      .text(`TOTAL: ${total.toFixed(2)}`)
      .size(0, 0);

    // 푸터
    printer
      .align("CT")
      .text("Thank you for your order!")
      .text("Kamtou Seafood Restaurant")
      .text("3779 Sexsmith Rd Unit 1298, Richmond, BC V6X 3Z9")
      .text("(604) 285-1668")
      .text(`GST Number: ${GSTNumber}`)
      .feed(3);

    // 고객용 영수증 커팅 및 버퍼 플러시
    printer.cut();
    await new Promise((resolve, reject) => {
      printer.flush((err) => {
        if (err) {
          log(`Failed to print customer receipt: ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // 2. 주방용 영수증 출력 (메뉴 단위로)
    if (items.length === 0) {
      log("No items to print for kitchen receipt");
    } else {
      for (const [itemIndex, item] of items.entries()) {
        printer.raw(Buffer.from([0x1b, 0x40])); // 프린터 초기화

        // 고객 정보 및 픽업 시간
        printer
          .align("LT")
          .size(1, 1)
          .text(`${customerName}(${shortOrderNumber})`)
          .size(0, 0)
          .text(`PICKUP at ${pickupTimeShort}, ${pickupDateShort}`)
          .text("------------------------------------------------");

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
                    optionText += `(${extractChineseText(
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
          wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach((line) =>
            printer.text(`  ${line}`)
          );
        }

        // 주방용 영수증 마무리
        printer.size(0, 0).feed(2);

        // 커팅 및 버퍼 플러시
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

    // print_status 업데이트
    try {
      await axios.post(
        `${API_URL}/update-print-status`,
        { order_id: order.id, print_status: "printed" },
        { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
      );
    } catch (error) {
      log(`Failed to update print status for order #${order.id}: ${error.message}`);
      return; // 에러 발생 시 더 이상 진행하지 않음
    }

    log(`Order #${orderNumber} printed successfully`);
  } catch (error) {
    log(`Error printing order #${order.order_number || "N/A"}: ${error.message}`);
  }
}

// API 폴링
async function pollOrders() {
  if (!JWT_TOKEN) {
    log("No token available, please login");
    io.emit("relogin", "Session expired, please re-login");
    return;
  }

  try {
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
      log("Token expired, please re-login");
      JWT_TOKEN = null;
      clearInterval(pollingInterval);
      pollingInterval = null;
      updateStatus("Stopped");
      io.emit("relogin", "Session expired, please re-login");
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
    log(`Login failed: ${errorMsg}`);
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
    log("Starting server");
    pollOrders();
    pollingInterval = setInterval(pollOrders, 3000);
    updateStatus("Running");
    res.json({ status: "started" });
  } else {
    log("Server already running");
    res.json({ status: "already_running" });
  }
});

app.get("/stop", (req, res) => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    log("Server stopped");
    updateStatus("Stopped");
    res.json({ status: "stopped" });
  } else {
    log("Server not running");
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
      log("No saved token found, please login");
    }
  } catch (error) {
    log(`Failed to initialize printer: ${error.message}`);
    process.exit(1);
  }
}

// WebSocket 연결
io.on("connection", (socket) => {
  log("Client connected");
  socket.on("disconnect", () => log("Client disconnected"));
});

// 서버 시작
init().then(() => {
  server.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
    updateStatus(pollingInterval ? "Running" : "Stopped");
  });
});

// 프로세스 종료 시 프린터 닫기
process.on("SIGINT", async () => {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    log("Polling stopped");
  }
  if (printer) {
    await new Promise((resolve, reject) => {
      printer.flush((err) => {
        if (err) {
          log(`Failed to flush printer buffer: ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
    await new Promise((resolve) => {
      printer.close(() => {
        log("Printer closed");
        resolve();
      });
    });
  }
  log("Server shutdown complete");
  process.exit();
});