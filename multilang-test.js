const escpos = require("escpos");
escpos.USB = require("escpos-usb");

// 프린터 설정 (USB 연결)
const device = new escpos.USB(0x04b8, 0x0202); // TM-U220PD의 Vendor ID와 Product ID
const printer = new escpos.Printer(device);

// 용지 설정: 76mm, 200 dot, 최대 40자
const MAX_LINE_CHARS = 40;

// 테스트 데이터
const testOrder = {
  order_number: "20250330-0BF3",
  created_at: "2025-03-30T22:52:00-07:00", // 주문 시간
  due_at: "2025-03-31T08:20:00-07:00", // 픽업 시간
  customer_name: "David Chan",
  customer_phone: "7789273157",
  customer_notes: "Please hurry up",
  cart: JSON.stringify([
    {
      quantity: 1,
      name: "Morning Set 早晨套餐",
      price: 25.0,
      subtotal: 27.5,
      options: [
        {
          choices: [
            {
              name: "Chinese Crepe 煎餅果子",
              extraPrice: 2.5,
              subOptions: [],
            },
          ],
        },
      ],
      specialInstructions: "Not too spicy 不要太辣",
    },
    {
      quantity: 1,
      name: "Hong Kong Milk Tea 港式奶茶",
      price: 5.0,
      subtotal: 5.0,
      options: [
        {
          choices: [
            {
              name: "Less Sugar 少糖",
              extraPrice: 0.0,
              subOptions: [],
            },
          ],
        },
      ],
      specialInstructions: "",
    },
  ]),
  subtotal: 32.5,
  gst: 1.63,
  tip: 1.31,
  total: 35.44,
};

function log(message) {
  console.log(
    `[${new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    })}] ${message}`
  );
}

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

    // 기본 Code Page 설정 (영어: PC437)
    printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0

    // 1. 고객용 영수증
    // 주문 번호 (중앙 정렬, 일반 크기)
    printer
      .align("ct")
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(`Order #${order.order_number || "N/A"}`)
      .text("----------------------------------------");

    // 픽업 시간 (좌측 정렬, 2배 높이)
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

    printer
      .align("lt")
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(pickupText)
      .raw(Buffer.from([0x1b, 0x21, 0x00])); // ESC ! 0x00 (기본 크기로 복귀)

    // 고객 정보 (일반 크기)
    const orderTime = orderDate.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Vancouver",
    });

    printer
      .text(`Customer: ${order.customer_name || "N/A"}`)
      .text(`Phone: ${order.customer_phone || "N/A"}`)
      .text(`Order Time: ${orderTime || "N/A"}`)
      .text(`Pickup Time: ${pickupTimeWithDateFormat || "N/A"}`);

    // 고객 노트 (일반 크기)
    if (order.customer_notes) {
      printer.text("----------------------------------------");
      printer.text("Customer Notes:");
      wrapText(order.customer_notes, MAX_LINE_CHARS).forEach((line) =>
        printer.text(`  ${line}`)
      );
    }

    // 아이템 목록 (일반 크기, 메뉴 좌측, 금액 우측)
    printer.text("----------------------------------------");
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
        const priceText = itemSubtotal;

        // 아이템 이름이 중국어 번체 포함 여부 확인
        const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName);
        if (isChineseItem) {
          printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
        } else {
          printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
        }

        const lines = wrapTextWithPrice(itemName, 27, priceText);
        lines.forEach((line, i) => {
          if (i === 0) {
            printer.text(
              line.padEnd(MAX_LINE_CHARS - priceText.length) + priceText
            );
          } else {
            printer.text(line);
          }
        });

        // 옵션 (일반 크기, 메뉴와 동일한 형식)
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

              const priceTextOption = totalPrice > 0 ? totalPrice : "0.00";
              const isChineseOption = /[\u4E00-\u9FFF]/.test(optionText);
              if (isChineseOption) {
                printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
              } else {
                printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
              }

              const optionLines = wrapTextWithPrice(
                optionText,
                27,
                priceTextOption
              );
              optionLines.forEach((line, i) => {
                if (i === 0) {
                  printer.text(
                    line.padEnd(MAX_LINE_CHARS - priceTextOption.length) +
                      priceTextOption
                  );
                } else {
                  printer.text(line);
                }
              });
            });
          });
        }

        // 노트 (일반 크기)
        if (item.specialInstructions) {
          const isChineseNote = /[\u4E00-\u9FFF]/.test(
            item.specialInstructions
          );
          if (isChineseNote) {
            printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
          } else {
            printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
          }
          printer.text("- Note:");
          wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach((line) =>
            printer.text(`  ${line}`)
          );
        }

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
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(`Subtotal: ${Number(order.subtotal || 0).toFixed(2)}`)
      .text(`GST (5%): ${Number(order.gst || 0).toFixed(2)}`)
      .text(`Tip: ${Number(order.tip || 0).toFixed(2)}`)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(`Total: ${Number(order.total || 0).toFixed(2)}`)
      .raw(Buffer.from([0x1b, 0x21, 0x00])); // ESC ! 0x00 (기본 크기로 복귀)

    // 마무리 (일반 크기)
    printer
      .align("ct")
      .text("----------------------------------------")
      .text("Thank you for your order!")
      .text("Night Owl Cafe")
      .text("#104-8580 Cambie Rd, Richmond, BC")
      .text("(604) 276-0576")
      .text("\n\n\n") // 3줄 띄우기
      .cut();

    // 2. 주방용 영수증
    // 주문 번호 (중앙 정렬, 일반 크기)
    printer
      .align("ct")
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(`Order #${order.order_number || "N/A"}`)
      .text("----------------------------------------");

    // Pickup과 픽업 시간 (좌우 정렬, 일반 크기)
    printer.text("Pickup".padEnd(20) + pickupTimeWithDateFormat);

    // 아이템 목록 (메뉴와 옵션 모두 2배 폭/높이)
    cart.forEach((item, index) => {
      const itemName = `${item.quantity || 1} x ${
        item.name || item.item_name || "Unknown"
      }`;

      // 아이템 이름 (2배 폭/높이)
      const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName);
      if (isChineseItem) {
        printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
      } else {
        printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
      }

      printer.raw(Buffer.from([0x1b, 0x21, 0x30])); // ESC ! 0x30 (2배 폭/높이)
      wrapText(itemName, MAX_LINE_CHARS).forEach((line) => printer.text(line));

      // 옵션 (2배 폭/높이)
      if (item.options && item.options.length > 0) {
        item.options.forEach((option) => {
          option.choices.forEach((choice) => {
            let optionText = `- ${choice.name || "N/A"}`;
            if (choice.subOptions && choice.subOptions.length > 0) {
              choice.subOptions.forEach((subOption) => {
                subOption.choices.forEach((subChoice) => {
                  optionText += ` - ${subChoice.name || "N/A"}`;
                });
              });
            }

            const isChineseOption = /[\u4E00-\u9FFF]/.test(optionText);
            if (isChineseOption) {
              printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
            } else {
              printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
            }

            wrapText(optionText, MAX_LINE_CHARS).forEach((line) =>
              printer.text(line)
            );
          });
        });
      }

      // 노트 (2배 폭/높이)
      if (item.specialInstructions) {
        const isChineseNote = /[\u4E00-\u9FFF]/.test(item.specialInstructions);
        if (isChineseNote) {
          printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
        } else {
          printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
        }
        printer.text("- Note:");
        wrapText(item.specialInstructions, MAX_LINE_CHARS).forEach((line) =>
          printer.text(`  ${line}`)
        );
      }

      printer.raw(Buffer.from([0x1b, 0x21, 0x00])); // ESC ! 0x00 (기본 크기로 복귀)
      if (index < cart.length - 1) {
        printer.text("----------------------------------------");
      }
    });

    // 하단 여백 및 절단
    printer.text("\n\n\n").cut();

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

// 긴 텍스트를 줄 바꿈 처리
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

// 스크립트 실행 시 바로 출력
(async () => {
  log("Starting test print...");
  await printOrder(testOrder);
  log("Test print completed");
})();
