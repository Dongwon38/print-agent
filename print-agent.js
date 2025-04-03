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
const PORT = process.env.PORT || 3000;
const TOKEN_FILE = "./jwt_token.txt";
const GSTNumber = "872046354"; // GST 번호 (환경 변수로 설정 가능)


// 시리얼 포트와 프린터 초기화 (기본적으로 열지 않음)
const serialPort = new SerialPort({ path: "COM1", baudRate: 9600, autoOpen: false });
const printer = new escpos.Printer(serialPort, { encoding: "Big5" });


// 용지 설정: 76mm, 200 dot, 최대 40자
const MAX_LINE_CHARS = 40;


let JWT_TOKEN = null;
let pollingInterval = null;


serialPort.on("error", (err) => {
log(`Serial port error: ${err.message}`);
});


function log(message) {
console.log(`[${new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" })}] ${message}`);
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
  return res.status(401).json({ status: "error", message: "Not authenticated" });
}
if (!pollingInterval) {
  log("Starting server...");
  pollOrders();
  pollingInterval = setInterval(pollOrders, 10000); // 10초 간격
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


// 2번 코드에서 가져온 wrapTextWithPrice 함수
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


if (currentLine) {
  if (isFirstLine) {
    lines.push(currentLine.padEnd(maxWidth - priceText.length) + priceText);
  } else {
    lines.push(currentLine);
  }
}


return lines;
}


// 2번 코드에서 가져온 wrapText 함수
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


// 2번 코드에서 가져온 extractChineseText 함수
function extractChineseText(text) {
const chineseMatch = text.match(/[\u4E00-\u9FFF]+/g);
return chineseMatch ? chineseMatch.join("") : text;
}


async function printOrder(order) {
log("Entering printOrder function");
let cart;
try {
  log("Parsing cart...");
  cart = order.cart ? JSON.parse(order.cart) : [];
  log("Cart parsed successfully");
} catch (e) {
  log(`Error parsing cart for order #${order.order_number}: ${e.message}`);
  return;
}


// 먼저 백엔드 상태를 "printed"로 업데이트
log("Updating print status to backend...");
try {
  await axios.post(
    `${API_URL}/update-print-status`,
    { order_id: order.id, print_status: "printed" },
    { headers: { Cookie: `jwt_token=${JWT_TOKEN}` } }
  );
  log(`Marked order #${order.id} as printed`);
} catch (error) {
  log(`Failed to update print status for order #${order.id}: ${error.message}`);
  return;
}


// 시리얼 포트 열기
try {
  log("Opening serial port...");
  await new Promise((resolve, reject) => {
    if (serialPort.isOpen) {
      log("Serial port already open, proceeding...");
      resolve();
    } else {
      serialPort.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    }
  });
  log("Serial port opened successfully");
} catch (error) {
  log(`Failed to open serial port: ${error.message}`);
  return;
}


const shortOrderNumber = order.order_number.split("-")[1] || "N/A";


log("Starting printer commands...");
try {
  log("Sending.ConcurrentModificationException printer initialization command...");
  printer.raw(Buffer.from([0x1b, 0x40])); // 프린터 초기화
  printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // 기본 Code Page (PC437)
  log("Printer initialized");


  // 1. 고객용 영수증
  log("Printing customer receipt...");
  printer
    .align("lt")
    .raw(Buffer.from([0x1d, 0x21, 0x10])) // 세로 2배 크기
    .text(`${order.customer_name || "N/A"}(${shortOrderNumber})`);


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
    .raw(Buffer.from([0x1d, 0x21, 0x00])) // 기본 크기
    .text(`Pickup at ${pickupTimeFormat}`)
    .text("----------------------------------------");


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


  if (order.customer_notes) {
    printer.text("Customer Notes:");
    wrapText(order.customer_notes, MAX_LINE_CHARS).forEach((line) =>
      printer.text(`  ${line}`)
    );
  }
  printer.text("\n");


  // 아이템 목록
  if (cart.length === 0) {
    printer.text("No items in this order.");
  } else {
    log("Printing items...");
    cart.forEach((item, index) => {
      const itemSubtotal = Number(
        item.subtotal || (item.basePrice || item.price) * (item.quantity || 1) || 0
      ).toFixed(2);
      const itemName = `${item.quantity || 1} x ${item.name || item.item_name || "Unknown"}`;
      const priceText = itemSubtotal.padStart(5, " ");


      const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName);
      if (isChineseItem) {
        printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // Code Page 950 Big5
        log(`Set Code Page to Big5 for item: ${itemName}`);
      } else {
        printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // PC437
        log(`Set Code Page to PC437 for item: ${itemName}`);
      }


      // 아이템 이름 길이 계산 ("1 x" 포함)
      const itemNameLength = (item.name || item.item_name || "Unknown").length + 3; // "1 x" (3자) 포함
      if (itemNameLength > 35) {
        const lines = wrapTextWithPrice(itemName, MAX_LINE_CHARS, priceText);
        lines.forEach((line) => printer.text(line));
      } else {
        const spaceLength = 40 - itemNameLength - 8; // 40 - 이름 길이 - 8
        const spaces = " ".repeat(Math.max(0, spaceLength));
        printer.text(`${itemName}${spaces}${priceText}`);
      }


      // 옵션
      if (item.options && item.options.length > 0) {
        item.options.forEach((option) => {
          option.choices.forEach((choice) => {
            let optionText = `- ${choice.name || "N/A"}`;
            let totalPrice = Number(
              choice.extraPrice || choice.additional_price || choice.price || 0
            ).toFixed(2);


            if (choice.subOptions && choice.subOptions.length > 0) {
              choice.subOptions.forEach((subOption) => {
                subOption.choices.forEach((subChoice) => {
                  const subPrice = Number(
                    subChoice.extraPrice || subChoice.additional_price || subChoice.price || 0
                  ).toFixed(2);
                  totalPrice = (Number(totalPrice) + Number(subPrice)).toFixed(2);
                  optionText += ` - ${subChoice.name || "N/A"}`;
                });
              });
            }


            const priceTextOption = totalPrice.padStart(4, " ");
            const isChineseOption = /[\u4E00-\u9FFF]/.test(optionText);
            if (isChineseOption) {
              printer.raw(Buffer.from([0x1b, 0x74, 0x15]));
              log(`Set Code Page to Big5 for option: ${optionText}`);
            } else {
              printer.raw(Buffer.from([0x1b, 0x74, 0x00]));
              log(`Set Code Page to PC437 for option: ${optionText}`);
            }


            const optionNameLength = (optionText || "N/A").length + 3; // "- " (2자) 포함
            if (optionNameLength > 35) {
              const optionLines = wrapTextWithPrice(optionText, MAX_LINE_CHARS, priceTextOption);
              optionLines.forEach((line) => printer.text(line));
            } else {
              const spaceLength = 40 - optionNameLength - 6;
              const spaces = " ".repeat(Math.max(0, spaceLength));
              printer.text(`${optionText}${spaces}${priceTextOption}`);
            }
          });
        });
      }


      // 노트
      if (item.specialInstructions) {
        const isChineseNote = /[\u4E00-\u9FFF]/.test(item.specialInstructions);
        if (isChineseNote) {
          printer.raw(Buffer.from([0x1b, 0x74, 0x15]));
          log(`Set Code Page to Big5 for note: ${item.specialInstructions}`);
        } else {
          printer.raw(Buffer.from([0x1b, 0x74, 0x00]));
          log(`Set Code Page to PC437 for note: ${item.specialInstructions}`);
        }
        printer.text("- Note: ");
        wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach((line) =>
          printer.text(`  ${line}`)
        );
      }


      if (index < cart.length - 1) {
        printer.text("----------------------------------------");
      }
    });
  }


  // 합계
  log("Printing totals...");
  printer
    .raw(Buffer.from([0x1b, 0x74, 0x00]))
    .text("----------------------------------------")
    .align("rt")
    .raw(Buffer.from([0x1d, 0x21, 0x00]))
    .text(`Subtotal: ${Number(order.subtotal || 0).toFixed(2)}`)
    .text(`GST (5%): ${Number(order.gst || 0).toFixed(2)}`)
    .text(`Tip: ${Number(order.tip || 0).toFixed(2)}`)
    .raw(Buffer.from([0x1d, 0x21, 0x10]))
    .text(`Total: ${Number(order.total || 0).toFixed(2)}`)
    .raw(Buffer.from([0x1d, 0x21, 0x00]));


  printer.text("\n");


  // 마무리
  printer
    .align("ct")
    .text("Thank you for your order!")
    .text("Night Owl Cafe")
    .text("#104-8580 Cambie Rd, Richmond, BC")
    .text("(604) 276-0576")
    .text(`GST Number: ${GSTNumber}`) // GST 번호 추가
    .text("\n\n\n")
    .cut();


  // 2. 주방용 영수증
  log("Printing kitchen receipt...");
  cart.forEach((item, itemIndex) => {
    printer
      .align("lt")
      .raw(Buffer.from([0x1d, 0x21, 0x10]))
      .text(`${order.customer_name || "N/A"}(${shortOrderNumber})`);


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
      .text(`Pickup`)
      .text(`${pickupTimeShort}, ${pickupDateShort}`);


    printer
      .raw(Buffer.from([0x1d, 0x21, 0x00]))
      .text("----------------------------------------");


    const itemName = `${item.quantity || 1} x ${extractChineseText(item.name || item.item_name || "Unknown")}`;
    const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName);
    if (isChineseItem) {
      printer.raw(Buffer.from([0x1b, 0x74, 0x15]));
      log(`Set Code Page to Big5 for kitchen item: ${itemName}`);
    } else {
      printer.raw(Buffer.from([0x1b, 0x74, 0x00]));
      log(`Set Code Page to PC437 for kitchen item: ${itemName}`);
    }


    printer.raw(Buffer.from([0x1d, 0x21, 0x11]));
    wrapText(itemName, MAX_LINE_CHARS, true).forEach((line) => printer.text(line));


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
            printer.raw(Buffer.from([0x1b, 0x74, 0x15]));
            log(`Set Code Page to Big5 for kitchen option: ${optionText}`);
          } else {
            printer.raw(Buffer.from([0x1b, 0x74, 0x00]));
            log(`Set Code Page to PC437 for kitchen option: ${optionText}`);
          }


          wrapText(optionText, MAX_LINE_CHARS, true).forEach((line) => printer.text(line));
        });
      });
    }


    if (item.specialInstructions) {
      printer.raw(Buffer.from([0x1b, 0x74, 0x00]));
      printer.text("- Note: ");
      wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach((line) =>
        printer.text(`  ${line}`)
      );
    }


    printer.raw(Buffer.from([0x1d, 0x21, 0x00]));
    printer.text("\n\n").cut();
  });


  log(`Printed order #${order.order_number || "N/A"} on Serial Port`);
  log("Flushing printer buffer...");
  await new Promise((resolve, reject) => {
    printer.flush((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  log("Printer buffer flushed");
} catch (error) {
  log(`Print error for order #${order.order_number || "N/A"}: ${error.message}`);
} finally {
  log("Waiting 5 seconds before closing serial port...");
  await new Promise((resolve) => setTimeout(resolve, 5000));
  log("Closing serial port...");
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
  } else {
    log("Serial port already closed");
  }
}
}


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
  const time = new Date().toLocaleTimeString("en-US", { timeZone: "America/Vancouver" });


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


async function init() {
try {
  if (await fs.access(TOKEN_FILE).then(() => true).catch(() => false)) {
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










