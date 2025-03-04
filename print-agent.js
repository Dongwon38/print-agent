const axios = require("axios");
const escpos = require("escpos");
escpos.USB = require("escpos-usb");

console.log("Initializing USB printer...");
const device = new escpos.USB(0x04b8, 0x0202); // EPSON TM-T88IV
const printer = new escpos.Printer(device);

const API_URL = "https://dongwonk5.sg-host.com/wp-json/custom/v1";

async function pollOrders() {
  try {
    const response = await axios.get(`${API_URL}/pending-orders`);
    const orders = response.data;

    const time = new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    });

    if (orders.length > 0) {
      console.log(`Found ${orders.length} new orders`);
      for (const order of orders) {
        await printOrder(order);
        await markOrderAsPrinted(order.id);
      }
    } else {
      console.log(time, ": No new order.");
    }
  } catch (error) {
    console.error("Polling error:", error.message);
  }
}

async function printOrder(order) {
  let cart;
  try {
    cart = JSON.parse(order.cart);
  } catch (e) {
    console.error("Error parsing cart:", e.message);
    cart = [];
  }

  try {
    console.log("Opening device...");
    await new Promise((resolve, reject) => {
      device.open((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    console.log("Device opened successfully");

    // 프린터 초기화 및 기본 크기 설정
    printer.font("a").align("ct");

    // 영수증 헤더 (크기 강조)
    printer
      .text(`ORDER #${order.order_number}`)
      .text("----------------------------------------");

    // 고객 정보
    printer
      .align("lt")
      .text(`Customer: ${order.customer_name}`)
      .text(`Phone: ${order.customer_phone}`)
      .text(`Email: ${order.customer_email || "N/A"}`)
      .text(`Order Time: ${order.created_at}`)
      .text(`Pickup Time: ${order.due_at}`)
      .text(`Order Type: ${order.order_type}`)
      .text("----------------------------------------");

    // 품목 목록 (가격 우측 정렬)
    printer.text("Items:");
    cart.forEach((item, index) => {
      const itemLine =
        `${index + 1}. ${item.name}`.padEnd(35) +
        `$${Number(item.subtotal).toFixed(2)}`;
      printer.text(itemLine);
      const basePriceLine =
        "   Base Price:".padEnd(35) + `$${Number(item.basePrice).toFixed(2)}`;
      printer.text(basePriceLine);
      item.options.forEach((option) => {
        option.choices.forEach((choice) => {
          const optionLine =
            `   - ${option.category}: ${choice.name}`.padEnd(35) +
            `$${Number(choice.extraPrice).toFixed(2)}`;
          printer.text(optionLine);
        });
      });
    });
    printer.text("----------------------------------------");

    // 요약 (가격 우측 정렬)
    printer
      .text(`Subtotal:`.padEnd(35) + `$${Number(order.subtotal).toFixed(2)}`)
      .text(`GST (5%):`.padEnd(35) + `$${Number(order.gst).toFixed(2)}`)
      .text(`PST:`.padEnd(35) + `$${Number(order.pst).toFixed(2)}`)
      .text(`Bag Fee:`.padEnd(35) + `$${Number(order.bag_fee).toFixed(2)}`)
      .text(
        `Deposit Fee:`.padEnd(35) + `$${Number(order.deposit_fee).toFixed(2)}`
      )
      .text(`Tip:`.padEnd(35) + `$${Number(order.tip).toFixed(2)}`)
      .text(`Total:`.padEnd(35) + `$${Number(order.total).toFixed(2)}`)
      .text("----------------------------------------");

    // 마무리 메시지 및 여백
    printer
      .align("ct")
      .text("Thank you for your order!")
      .feed(4) // 4줄 여백
      .cut();

    await new Promise((resolve, reject) => {
      printer.close(() => resolve(), reject);
    });
    console.log("Device closed");
    console.log(`Printed order #${order.order_number}`);
  } catch (error) {
    console.error("Print error:", error.message);
  }
}

async function markOrderAsPrinted(orderId) {
  try {
    await axios.post(`${API_URL}/update-print-status`, {
      order_id: orderId,
      print_status: "printed",
    });
    console.log(`Marked order #${orderId} as printed`);
  } catch (error) {
    console.error("Update error:", error.message);
  }
}

setInterval(pollOrders, 5000);
pollOrders();
