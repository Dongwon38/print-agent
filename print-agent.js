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

const API_URL = process.env.API_URL;
const PORT = process.env.PORT;
const TOKEN_FILE = "./jwt_token.txt";

let JWT_TOKEN = null;
let pollingInterval = null;

// 프린터 설정 (USB 연결)
const device = new escpos.USB(0x04b8, 0x0202); // TM-U220PD의 Vendor ID와 Product ID
const printer = new escpos.Printer(device);

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

async function printOrder(order) {
  let cart;
  try {
    cart = order.cart ? JSON.parse(order.cart) : [];
  } catch (e) {
    log(`Error parsing cart for order #${order.order_number}: ${e.message}`);
    return;
  }

  try {
    // 프린터 연결
    await new Promise((resolve, reject) => {
      device.open((err) => {
        if (err) {
          reject(new Error(`Printer connection error: ${err.message}`));
        } else {
          resolve();
        }
      });
    });

    // 프린터 초기화
    printer.raw(Buffer.from([0x1b, 0x40])); // ESC @ (프린터 초기화)

    // 기본 Code Page 설정 (영어)
    printer.control("ESC t 0");

    // 주문 번호 (글씨 크기 2배)
    printer
      .align("ct")
      .style("bu")
      .size(2, 2)
      .text(`#${order.order_number || "N/A"}`)
      .size(1, 1)
      .style("normal")
      .text("---------------------------------");

    // 픽업 시간
    const orderDate = new Date(order.created_at);
    const pickupDate = new Date(order.due_at);
    const timeDiff = Math.round((pickupDate - orderDate) / (1000 * 60));

    const pickupTimeFormat = pickupDate.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });
    const pickupTimeWithDateFormat = pickupDate.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });

    const isSameDay =
      orderDate.toLocaleDateString("en-US", {
        timeZone: "America/Vancouver",
      }) ===
      pickupDate.toLocaleDateString("en-US", { timeZone: "America/Vancouver" });

    let pickupText;
    if (!isSameDay) {
      pickupText = `Pickup at ${pickupTimeWithDateFormat}`;
    } else if (timeDiff < 60) {
      pickupText = `Pickup at ${pickupTimeFormat} (in ${timeDiff} mins)`;
    } else {
      const hours = Math.floor(timeDiff / 60);
      const minutes = timeDiff % 60;
      pickupText = `Pickup at ${pickupTimeFormat} (in ${hours} hr ${minutes} mins)`;
    }

    printer.align("lt").size(2, 2).text(pickupText).size(1, 1);

    // 고객 정보
    const orderTime = orderDate.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });

    // 고객 이름이 한국어일 경우 Code Page 949 설정
    const customerName = order.customer_name || "N/A";
    const isKorean = /[\u3131-\uD79D]/.test(customerName); // 한국어 문자 여부 확인
    if (isKorean) {
      printer.control("ESC t 16"); // Code Page 949 (EUC-KR)
    }

    printer
      .text(`Customer: ${customerName}`)
      .text(`Phone: ${order.customer_phone || "N/A"}`)
      .text(`Order Time: ${orderTime || "N/A"}`)
      .text(`Pickup Time: ${pickupTimeWithDateFormat || "N/A"}`);

    // 고객 노트
    if (order.customer_notes) {
      printer.text("---------------------------------");
      printer.text("Customer Notes:");
      wrapText(order.customer_notes, 33).forEach((line) => printer.text(line));
    }

    // 아이템 목록
    printer.text("---------------------------------");
    if (cart.length === 0) {
      printer.text("No items in this order.");
    } else {
      cart.forEach((item, index) => {
        const itemSubtotal = Number(
          item.subtotal || item.price * item.quantity || 0
        ).toFixed(2);
        const itemName = `${item.quantity || 1} x ${
          item.name || item.item_name || "Unknown"
        }`;
        const priceText = `  $${itemSubtotal}`;

        // 아이템 이름이 다국어일 경우 Code Page 설정
        const isKoreanItem = /[\u3131-\uD79D]/.test(itemName); // 한국어
        const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName); // 중국어
        const isJapaneseItem = /[\u3040-\u30FF]/.test(itemName); // 일본어

        if (isKoreanItem) {
          printer.control("ESC t 16"); // Code Page 949 (EUC-KR)
        } else if (isChineseItem) {
          printer.control("ESC t 20"); // Code Page 936 (GB2312)
        } else if (isJapaneseItem) {
          printer.control("ESC t 17"); // Code Page 932 (Shift-JIS)
        } else {
          printer.control("ESC t 0"); // 기본 Code Page
        }

        // 아이템 (글씨 크기 2배)
        printer.size(2, 2);
        const lines = wrapTextWithPrice(itemName, 20, priceText);
        lines.forEach((line, i) => {
          if (i === 0) {
            printer.text(line.padEnd(33 - priceText.length) + priceText);
          } else {
            printer.text(line);
          }
        });
        printer.size(1, 1);

        if (item.options && item.options.length > 0) {
          item.options.forEach((option) => {
            option.choices.forEach((choice) => {
              let optionText = `- ${choice.name || "N/A"}`;
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
                    totalPrice += subPrice;
                    optionText += ` - ${subChoice.name || "N/A"}`;
                  });
                });
              }

              const priceTextOption =
                totalPrice > 0 ? `$${totalPrice.toFixed(2)}` : "(CA$0.00)";
              const optionLines = wrapTextWithPrice(
                optionText,
                20,
                priceTextOption
              );
              optionLines.forEach((line, i) => {
                if (i === 0) {
                  printer.text(
                    line.padEnd(33 - priceTextOption.length) + priceTextOption
                  );
                } else {
                  printer.text(line);
                }
              });
            });
          });
        }

        if (item.specialInstructions) {
          printer.text("- Note:");
          wrapText(item.specialInstructions, 33).forEach((line) =>
            printer.text(`  ${line}`)
          );
        }

        if (index < cart.length - 1) {
          printer.text("---------------------------------");
        }
      });
    }

    // 합계
    printer
      .control("ESC t 0") // 기본 Code Page로 복귀
      .text("---------------------------------")
      .align("rt")
      .text(`Subtotal: $${Number(order.subtotal || 0).toFixed(2)}`)
      .text(`GST (5%): $${Number(order.gst || 0).toFixed(2)}`)
      .text(`Tip: $${Number(order.tip || 0).toFixed(2)}`)
      .size(2, 2)
      .text(`Total: $${Number(order.total || 0).toFixed(2)}`)
      .size(1, 1);

    // 마무리
    printer
      .align("ct")
      .text("---------------------------------")
      .text("Thank you for your order!")
      .text("Night Owl Cafe")
      .text("#104-8580 Cambie Rd, Richmond, BC")
      .text("(604) 276-0576")
      .text("\n\n\n") // 3줄 띄우기
      .cut();

    // 프린터 명령 실행
    await new Promise((resolve, reject) => {
      printer.close((err) => {
        if (err) {
          reject(new Error(`Printer close error: ${err.message}`));
        } else {
          resolve();
        }
      });
    });

    log(`Printed order #${order.order_number || "N/A"} on USB`);

    // 주문 상태 업데이트
    await axios.post(
      `${API_URL}/update-print-status`,
      { order_id: order.id, print_status: "printed" },
      { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
    );
    log(`Marked order #${order.id} as printed`);
  } catch (error) {
    log(
      `Print error for order #${order.order_number || "N/A"} on USB: ${
        error.message
      }`
    );
  }
}

// 긴 텍스트를 가격과 분리해서 줄 바꿈 처리
function wrapTextWithPrice(text, maxWidth, price) {
  const lines = [];
  let currentLine = "";

  const words = text.split(" ");
  words.forEach((word) => {
    if ((currentLine + " " + word).length <= maxWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length <= maxWidth ? word : word.slice(0, maxWidth);
    }
  });
  if (currentLine) lines.push(currentLine);
  return lines;
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
          await printOrder(order);
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

function wrapText(text, maxWidth) {
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
  return lines;
}
