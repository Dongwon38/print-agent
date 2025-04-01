const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const axios = require("axios");
const fs = require("fs").promises;
const escpos = require("escpos");
const { SerialPort } = require("serialport");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const API_URL = process.env.API_URL;
const PORT = process.env.PORT;
const TOKEN_FILE = "./jwt_token.txt";

// 가상 COM 포트로 연결 (COM1로 설정했다고 가정)
const serialPort = new SerialPort({ path: "COM1", baudRate: 9600 });

// escpos.Printer를 사용하여 시리얼 포트에 연결
const printer = new escpos.Printer(serialPort, { encoding: "Big5" });

// 용지 설정: 76mm, 200 dot, 최대 40자
const MAX_LINE_CHARS = 40;

let JWT_TOKEN = null;
let pollingInterval = null;
const GSTNumber = 872046354;

function log(message) {
  console.log(
    `[${new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    })}] ${message}`
  );
  io.emit("log", message);
}

function updateStatus(status) {
  io.emit("status", status);
}

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

app.get("/start", (req, res) => {
  if (!JWT_TOKEN) {
    log("Please login first");
    return res
      .status(401)
      .json({ status: "error", message: "Not authenticated" });
  }
  if (!pollingInterval) {
    log("Starting server...");
    pollOrders();
    pollingInterval = setInterval(pollOrders, 5000);
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

// 긴 텍스트를 가격과 분리해서 줄 바꿈 처리 (금액은 첫 줄 우측에 고정, 첫 줄에만 가격 출력)
function wrapTextWithPrice(text, maxWidth, price) {
  const lines = [];
  const priceText = price.toString();
  const availableWidth = maxWidth - priceText.length - 2; // 가격과 공백을 고려

  let currentLine = "";
  const words = text.split(" ");
  let isFirstLine = true;

  words.forEach((word) => {
    if ((currentLine + " " + word).length <= availableWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) {
        if (isFirstLine) {
          lines.push(currentLine.padEnd(maxWidth - priceText.length) + priceText);
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

  // 마지막 줄 처리
  if (currentLine) {
    if (isFirstLine) {
      lines.push(currentLine.padEnd(maxWidth - priceText.length) + priceText);
    } else {
      lines.push(currentLine);
    }
  }

  return lines;
}

// 긴 텍스트를 줄 바꿈 처리 (주방 영수증용, 줄간격 추가)
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

  // 줄간격 추가 (주방 영수증용)
  if (addSpacing) {
    return lines.flatMap((line) => [line, "\n"]);
  }
  return lines;
}

// 중국어 번체만 추출하는 함수
function extractChineseText(text) {
  const chineseMatch = text.match(/[\u4E00-\u9FFF]+/g);
  return chineseMatch ? chineseMatch.join("") : text;
}

// 영수증 출력 함수
function printOrder(order) {
  let cart;
  try {
    cart = order.cart ? JSON.parse(order.cart) : [];
  } catch (e) {
    log(`Error parsing cart for order #${order.order_number}: ${e.message}`);
    return;
  }

  const shortOrderNumber = order.order_number.split("-")[1] || "N/A";

  // 시리얼 포트 열기
  serialPort.on("open", () => {
    log("Serial port opened successfully");

    try {
      // 프린터 초기화
      log("Initializing printer...");
      printer.raw(Buffer.from([0x1b, 0x40])); // ESC @ (프린터 초기화)

      // 기본 Code Page 설정 (영어: PC437)
      printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0
      log("Printer initialized with Code Page PC437");

      // 1. 고객용 영수증
      log("Printing customer receipt...");
      // 고객 이름과 오더 넘버 (중앙 정렬, 세로 2배 크기)
      printer
        .align("lt")
        .raw(Buffer.from([0x1d, 0x21, 0x10])) // GS ! 0x10 (세로 2배 크기)
        .text(`${order.customer_name || "N/A"}(${shortOrderNumber})`);

      // 픽업 시간 (중앙 정렬, "Pickup at"은 기본 크기, 날짜/시간은 세로 2배 크기)
      const pickupDate = new Date(order.due_at);
      const pickupTimeFormat = pickupDate.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/Vancouver",
      });
      printer
        .raw(Buffer.from([0x1d, 0x21, 0x00])) // GS ! 0x00 (기본 크기)
        .text(`Pickup at ${pickupTimeFormat}`);
      printer.text("----------------------------------------");

      const orderDate = new Date(order.created_at);
      const orderTime = orderDate.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/Vancouver",
      });

      printer
        .text(`Order at ${orderTime || "N/A"}`)
        .text(`Phone: ${order.customer_phone || "N/A"}`);

      // 고객 노트 (기본 크기)
      if (order.customer_notes) {
        printer.text("Customer Notes:");
        wrapText(order.customer_notes, MAX_LINE_CHARS).forEach((line) =>
          printer.text(`  ${line}`)
        );
      }
      printer.text("\n");

      // 아이템 목록 (기본 크기, 메뉴 좌측, 금액 우측)
      if (cart.length === 0) {
        printer.text("No items in this order.");
      } else {
        cart.forEach((item, index) => {
          const itemSubtotal = Number(
            item.subtotal || (item.basePrice || item.price) * (item.quantity || 1) || 0
          ).toFixed(2);
          const itemName = `${item.quantity || 1} x ${
            item.name || item.item_name || "Unknown"
          }`;
          const priceText = itemSubtotal.padStart(5, " "); // 5자리로 고정

          // 아이템 이름이 중국어 번체 포함 여부 확인
          const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName);
          if (isChineseItem) {
            printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
            log(`Set Code Page to Big5 for item: ${itemName}`);
          } else {
            printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
            log(`Set Code Page to PC437 for item: ${itemName}`);
          }

          // 아이템 이름 길이 계산 ("1 x" 포함)
          const itemNameLength = (item.name || item.item_name || "Unknown").length + 3; // "1 x" (3자) 포함
          if (itemNameLength > 35) {
            // 길이가 35자 초과: wrapTextWithPrice 사용
            const lines = wrapTextWithPrice(itemName, MAX_LINE_CHARS, priceText);
            lines.forEach((line) => printer.text(line));
          } else {
            // 길이가 35자 이하: 공백 계산 후 한 줄로 출력
            const spaceLength = 40 - itemNameLength - 8; // 40 - 이름 길이 - 8
            const spaces = " ".repeat(Math.max(0, spaceLength)); // 음수 방지
            printer.text(`${itemName}${spaces}${priceText}`);
          }

          // 옵션 (기본 크기, 메뉴와 동일한 형식)
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
                      optionText += ` - ${subChoice.name || "N/A"}`;
                    });
                  });
                }

                const priceTextOption = totalPrice.padStart(4, " "); // 4자리로 고정
                const isChineseOption = /[\u4E00-\u9FFF]/.test(optionText);
                if (isChineseOption) {
                  printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
                  log(`Set Code Page to Big5 for option: ${optionText}`);
                } else {
                  printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
                  log(`Set Code Page to PC437 for option: ${optionText}`);
                }

                // 옵션 이름 길이 계산 ("- " 포함)
                const optionNameLength = (choice.name || "N/A").length + 3; // "- " (2자) 포함
                if (optionNameLength > 35) {
                  // 길이가 35자 초과: wrapTextWithPrice 사용
                  const optionLines = wrapTextWithPrice(
                    optionText,
                    MAX_LINE_CHARS,
                    priceTextOption
                  );
                  optionLines.forEach((line) => printer.text(line));
                } else {
                  // 길이가 35자 이하: 공백 계산 후 한 줄로 출력
                  const spaceLength = 40 - optionNameLength - 8; // 40 - 이름 길이 - 8
                  const spaces = " ".repeat(Math.max(0, spaceLength)); // 음수 방지
                  printer.text(`${optionText}${spaces}${priceTextOption}`);
                }
              });
            });
          }

          // 노트 (기본 크기)
          if (item.specialInstructions) {
            const isChineseNote = /[\u4E00-\u9FFF]/.test(
              item.specialInstructions
            );
            if (isChineseNote) {
              printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
              log(`Set Code Page to Big5 for note: ${item.specialInstructions}`);
            } else {
              printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
              log(`Set Code Page to PC437 for note: ${item.specialInstructions}`);
            }
            printer.text("- Note: ");
            wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach(
              (line) => printer.text(`  ${line}`)
            );
          }

          // 각 아이템 사이에 구분선 추가
          if (index < cart.length - 1) {
            printer.text("----------------------------------------");
          }
        });
      }

      // 합계 (총액만 2배 높이)
      printer
        .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
        .text("----------------------------------------")
        .align("rt")
        .raw(Buffer.from([0x1d, 0x21, 0x00])) // GS ! 0x00 (기본 크기)
        .text(`Subtotal: ${Number(order.subtotal || 0).toFixed(2)}`)
        .text(`GST (5%): ${Number(order.gst || 0).toFixed(2)}`)
        .text(`Tip: ${Number(order.tip || 0).toFixed(2)}`)
        .raw(Buffer.from([0x1d, 0x21, 0x10])) // GS ! 0x10 (2배 높이)
        .text(`Total: ${Number(order.total || 0).toFixed(2)}`)
        .raw(Buffer.from([0x1d, 0x21, 0x00])); // GS ! 0x00 (기본 크기로 복귀)

      // Total 아래 여백 1줄 추가 (구분선 제거)
      printer.text("\n");

      // 마무리 (기본 크기)
      printer
        .align("ct")
        .text("Thank you for your order!")
        .text("Night Owl Cafe")
        .text("#104-8580 Cambie Rd, Richmond, BC")
        .text("(604) 276-0576")
        .text(`GST Number: ${GSTNumber}`)
        .text("\n\n\n") // 3줄 띄우기
        .cut();

      // 2. 주방용 영수증 (아이템별로 출력)
      log("Printing kitchen receipts...");
      cart.forEach((item, itemIndex) => {
        // 고객 이름과 오더 넘버 (중앙 정렬, 세로 2배 크기)
        printer
          .align("lt")
          .raw(Buffer.from([0x1d, 0x21, 0x10])) // GS ! 0x10 (세로 2배 크기)
          .text(`${order.customer_name || "N/A"}(${shortOrderNumber})`);

        // Takeout, 시간, 날짜 (좌측 정렬, 세로 2배 크기)
        const pickupTimeShort = pickupDate.toLocaleString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/Vancouver",
        });
        const pickupDateShort = pickupDate.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "America/Vancouver",
        });
        printer
          .align("lt")
          .text(`Pickup`);
        printer.text(`${pickupTimeShort}, ${pickupDateShort}`);

        // 구분선
        printer
          .raw(Buffer.from([0x1d, 0x21, 0x00])) // GS ! 0x00 (기본 크기)
          .text("----------------------------------------");

        // 아이템 (가로 2배 세로 2배 크기, 중국어 번체만 출력)
        const itemName = `${item.quantity || 1} x ${extractChineseText(
          item.name || item.item_name || "Unknown"
        )}`;

        // 아이템 이름 (가로 2배 세로 2배 크기)
        const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName);
        if (isChineseItem) {
          printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
          log(`Set Code Page to Big5 for kitchen item: ${itemName}`);
        } else {
          printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
          log(`Set Code Page to PC437 for kitchen item: ${itemName}`);
        }

        printer
          .align("lt")
          .raw(Buffer.from([0x1d, 0x21, 0x11])); // GS ! 0x11 (가로 2배 세로 2배 크기)
        wrapText(itemName, MAX_LINE_CHARS, true).forEach((line) =>
          printer.text(line)
        );

        // 옵션 (가로 2배 세로 2배 크기, 중국어 번체만 출력)
        if (item.options && item.options.length > 0) {
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              let optionText = `- ${extractChineseText(choice.name || "N/A")}`;
              if (choice.subOptions && choice.subOptions.length > 0) {
                choice.subOptions.forEach((subOption) => {
                  subOption.choices.forEach((subChoice) => {
                    optionText += ` - ${extractChineseText(subChoice.name || "N/A")}`;
                  });
                });
              }

              const isChineseOption = /[\u4E00-\u9FFF]/.test(optionText);
              if (isChineseOption) {
                printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
                log(`Set Code Page to Big5 for kitchen option: ${optionText}`);
              } else {
                printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
                log(`Set Code Page to PC437 for kitchen option: ${optionText}`);
              }

              wrapText(optionText, MAX_LINE_CHARS, true).forEach((line) =>
                printer.text(line)
              );
            });
          });
        }

        // 노트 (가로 2배 세로 2배 크기)
        if (item.specialInstructions) {
          printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
          printer.text("- Note: ");
          wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach(
            (line) => printer.text(`  ${line}`)
          );
        }

        printer.raw(Buffer.from([0x1d, 0x21, 0x00])); // GS ! 0x00 (기본 크기로 복귀)

        // 하단 여백 및 절단
        printer.text("\n\n").cut();
      });

      printer.close();
      log(`Printed order #${order.order_number || "N/A"} on Serial Port`);
    } catch (error) {
      log(
        `Print error for order #${order.order_number || "N/A"} on Serial Port: ${
          error.message
        }`
      );
      printer.close();
    }
  });

  // 시리얼 포트 에러 핸들링
  serialPort.on("error", (err) => {
    log(`Serial port error: ${err.message}`);
  });

  // 시리얼 포트 열기 실패 시 에러 핸들링
  serialPort.on("close", () => {
    log("Serial port closed unexpectedly");
  });
}

async function pollOrders() {
  if (!JWT_TOKEN) {
    log("No token available, please login first.");
    io.emit("relogin", "Session expired, please re-login.");
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
          log(`Order #${order.order_number || "N/A"} detected, printing...`);
          printOrder(order);
          // 주문 상태 업데이트
          await axios.post(
            `${API_URL}/update-print-status`,
            { order_id: order.id, print_status: "printed" },
            { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
          );
          log(`Marked order #${order.id} as printed`);
        } else {
          log(
            `Order #${order.order_number || "N/A"} already printed or not paid`
          );
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

async function init() {
  try {
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
    log(`Error loading token: ${error.message}`);
  }
}

init().then(() => {
  server.listen(PORT, () => {
    log(`Server running on http://localhost:${PORT}`);
    updateStatus(pollingInterval ? "Running" : "Stopped");
  });
});

io.on("connection", (socket) => {
  log("Client connected to WebSocket");
  socket.on("disconnect", () => log("Client disconnected"));
});