const escpos = require("escpos");
const { SerialPort } = require("serialport");

// 가상 COM 포트로 연결 (COM1로 설정했다고 가정)
const serialPort = new SerialPort({ path: "COM1", baudRate: 9600 });

// escpos.Printer를 사용하여 시리얼 포트에 연결
const printer = new escpos.Printer(serialPort, { encoding: "Big5" });

// 용지 설정: 76mm, 200 dot, 최대 40자
const MAX_LINE_CHARS = 40;

// 테스트 데이터 (하드코딩, 긴 메뉴 이름 포함)
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
    {
      quantity: 1,
      name: "Special Hong Kong Style Breakfast Set with Extra Toppings 特別港式早餐套餐加料",
      price: 30.0,
      subtotal: 30.0,
      options: [],
      specialInstructions: "",
    },
  ]),
  subtotal: 62.5,
  gst: 3.13,
  tip: 2.50,
  total: 68.13,
};

function log(message) {
  console.log(
    `[${new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    })}] ${message}`
  );
}

// 긴 텍스트를 가격과 분리해서 줄 바꿈 처리 (금액은 첫 줄 우측에 고정, 첫 줄에만 가격 출력)
function wrapTextWithPrice(text, maxWidth) {
  const lines = [];
  const priceText = this.priceText; // 컨텍스트에서 priceText 가져오기
  const availableWidth = maxWidth - 5 - 2; // 가격(5자리) + 공백 2칸

  let currentLine = "";
  const words = text.split(" ");
  let isFirstLine = true;

  // 전체 텍스트 길이를 계산하여 한 줄로 출력 가능한지 확인
  const fullText = text.trim();
  if (fullText.length <= availableWidth) {
    // 한 줄로 출력 가능
    lines.push(fullText.padEnd(maxWidth - 5) + priceText);
    return lines;
  }

  // 여러 줄로 출력
  words.forEach((word) => {
    if ((currentLine + " " + word).length <= availableWidth) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) {
        if (isFirstLine) {
          lines.push(currentLine.padEnd(maxWidth - 5) + priceText);
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
      lines.push(currentLine.padEnd(maxWidth - 5) + priceText);
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
    const spacedLines = [];
    lines.forEach((line, index) => {
      spacedLines.push(line);
      if (index < lines.length - 1) {
        // 마지막 줄 제외하고 여백 추가
        spacedLines.push("spacing"); // 여백 줄 표시
      }
    });
    return spacedLines;
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

  // 오더 넘버에서 마지막 4자리 추출
  const shortOrderNumber = order.order_number.split("-")[1] || "N/A";

  // 시리얼 포트 열기
  serialPort.on("open", () => {
    log("Serial port opened");

    try {
      // 프린터 초기화
      printer.raw(Buffer.from([0x1b, 0x40])); // ESC @ (프린터 초기화)

      // 기본 Code Page 설정 (영어: PC437)
      printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0

      // 1. Customer Receipt
      // =============== HEADER =============== //
      // customer_name(ordernumber)
      printer
        .align("lt")
        .raw(Buffer.from([0x1d, 0x21, 0x10])) // GS ! 0x10 (세로 2배 크기)
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

      // Pickup Time
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
        .text(`Phone: ${order.customer_phone || "N/A"}`)
        .text(`Order at: ${orderTime || "N/A"}`);

      if (order.customer_notes) {
        printer.text("Customer Notes:");
        wrapText(order.customer_notes, MAX_LINE_CHARS).forEach((line) =>
          printer.text(`  ${line}`)
        );
      }

      printer.text("\n");
      // =============== HEADER END =============== //

      // 아이템 목록 (기본 크기, 메뉴 좌측, 금액 우측)
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
          const priceText = itemSubtotal.padStart(5, " "); // 5자리로 고정

          // 아이템 이름이 중국어 번체 포함 여부 확인
          const isChineseItem = /[\u4E00-\u9FFF]/.test(itemName);
          if (isChineseItem) {
            printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
          } else {
            printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
          }

          // wrapTextWithPrice에 priceText 전달
          const context = { priceText };
          const lines = wrapTextWithPrice.call(context, itemName, MAX_LINE_CHARS);
          lines.forEach((line) => printer.text(line));

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

                const priceTextOption = totalPrice.padStart(5, " "); // 5자리로 고정
                const isChineseOption = /[\u4E00-\u9FFF]/.test(optionText);
                if (isChineseOption) {
                  printer.raw(Buffer.from([0x1b, 0x74, 0x15])); // ESC t 0x15 (Code Page 950, Big5)
                } else {
                  printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
                }

                const contextOption = { priceText: priceTextOption };
                const optionLines = wrapTextWithPrice.call(contextOption, optionText, MAX_LINE_CHARS);
                optionLines.forEach((line) => printer.text(line));
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
            } else {
              printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
            }
            printer.text("- Note:");
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
        .text("\n\n\n") // 3줄 띄우기
        .cut();

      // 2. 주방용 영수증 (아이템별로 출력)
      cart.forEach((item, itemIndex) => {
        // 고객 이름과 오더 넘버 (중앙 정렬, 세로 2배 크기)
        printer
          .align("ct")
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
          .text(`Takeout`);
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
        } else {
          printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
        }

        printer
          .align("lt")
          .raw(Buffer.from([0x1d, 0x21, 0x11])); // GS ! 0x11 (가로 2배 세로 2배 크기)
        wrapText(itemName, MAX_LINE_CHARS, true).forEach((line) => {
          if (line === "spacing") {
            printer.raw(Buffer.from([0x1d, 0x21, 0x00])); // 기본 크기로 변경
            printer.text("\n");
            printer.raw(Buffer.from([0x1d, 0x21, 0x11])); // 다시 2배 크기로 복귀
          } else {
            printer.text(line);
          }
        });

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
              } else {
                printer.raw(Buffer.from([0x1b, 0x74, 0x00])); // ESC t 0 (PC437)
              }

              wrapText(optionText, MAX_LINE_CHARS, true).forEach((line) => {
                if (line === "spacing") {
                  printer.raw(Buffer.from([0x1d, 0x21, 0x00])); // 기본 크기로 변경
                  printer.text("\n");
                  printer.raw(Buffer.from([0x1d, 0x21, 0x11])); // 다시 2배 크기로 복귀
                } else {
                  printer.text(line);
                }
              });
            });
          });
        }

        // 노트 (가로 2배 세로 2배 크기, 중국어 번체만 출력)
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
          const chineseNote = extractChineseText(item.specialInstructions);
          wrapText(chineseNote, MAX_LINE_CHARS, true).forEach((line) => {
            if (line === "spacing") {
              printer.raw(Buffer.from([0x1d, 0x21, 0x00])); // 기본 크기로 변경
              printer.text("\n");
              printer.raw(Buffer.from([0x1d, 0x21, 0x11])); // 다시 2배 크기로 복귀
            } else {
              printer.text(`  ${line}`);
            }
          });
        }

        printer.raw(Buffer.from([0x1d, 0x21, 0x00])); // GS ! 0x00 (기본 크기로 복귀)

        // 하단 여백 및 절단
        printer.text("\n\n\n").cut();
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

  // 에러 핸들링
  serialPort.on("error", (err) => {
    log(`Serial port error: ${err.message}`);
  });
}

// 스크립트 실행 시 바로 출력
log("Starting test print...");
printOrder(testOrder);