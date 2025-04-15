const MAX_LINE_CHARS = 48;
const sampleOrder = {
  customer_name: "John Doe",
  order_number: "KT-1052",
  due_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  customer_phone: "778-123-4567",
  customer_notes: "Please call when ready.",
  subtotal: 50.5,
  gst: 2.52,
  tip: 5.00,
  total: 58.02,
  "cart": [
    {
      "id": "cart-item-001",
      "name": "Omelette with Shredded Ham / 鮮茄火腿蘑菇庵列 + 鮮茄火腿蘑菇庵列鮮茄火腿蘑菇庵列火腿絲通粉",
      "basePrice": 17.45,
      "quantity": 1,
      "subtotal": 17.45,
      "options": [
        {
          "category": "Beverage Selection / 選擇飲料",
          "choices": [
            {
              "name": "Milk Tea / 港式奶茶港式奶茶港式奶茶港式奶茶",
              "extraPrice": 0,
              "subOptions": [
                {
                  "category": "Temperature / 溫度",
                  "choices": [
                    {
                      "name": "Hot / 熱",
                      "extraPrice": 0
                    }
                  ]
                }
              ]
            }
          ]
        }
      ],
      "specialInstructions": ""
    },
  ]
};


function formatPrice(price) {
  const priceStr = Number(price).toFixed(2);
  const priceLength = priceStr.length;
  const padding = Math.max(1, 7 - priceLength);
  const formatted = " ".repeat(padding) + priceStr;
  return formatted;
}

function wrapTextWithPrice(text, prefix, price) {
  const lines = [];
  const priceText = formatPrice(price);
  const priceLength = priceText.length;
  const prefixLength = prefix.length;

  const firstLineAvailableWidth = MAX_LINE_CHARS - prefixLength - priceLength;
  const subsequentLineAvailableWidth = MAX_LINE_CHARS - priceLength;

  let currentLine = "";
  let currentLineLength = 0;
  let isFirstLine = true;

  const chars = [...text]; // 문자 단위로 자르기

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const charLength = /[\u4E00-\u9FFF]/.test(char) ? 2 : 1;
    const availableWidth = isFirstLine
      ? firstLineAvailableWidth
      : subsequentLineAvailableWidth;

    if (currentLineLength + charLength <= availableWidth) {
      // 현재 줄에 추가 가능
      currentLine += char;
      currentLineLength += charLength;
    } else {
      // 줄이 꽉 찼으니 줄바꿈
      let line;
      if (isFirstLine) {
        const spaces = " ".repeat(MAX_LINE_CHARS - (prefixLength + currentLineLength + priceText.length));
        line = prefix + currentLine + spaces + priceText;
        isFirstLine = false;
      } else {
        const spaces = " ".repeat(MAX_LINE_CHARS - (currentLineLength + priceText.length));
        line = currentLine + spaces;
      }
      lines.push(line);

      // 줄 초기화
      currentLine = char;
      currentLineLength = charLength;
    }
  }

  // 마지막 남은 글자 처리
  if (currentLine) {
    let line;
    if (isFirstLine) {
      const spaces = " ".repeat(MAX_LINE_CHARS - (prefixLength + currentLineLength + priceText.length));
      line = prefix + currentLine + spaces + priceText;
    } else {
      const spaces = " ".repeat(MAX_LINE_CHARS - (currentLineLength + priceText.length));
      line = currentLine + spaces;
    }
    lines.push(line);
  }

  // 디버깅 출력
  lines.forEach((line) => console.log(`"${line}"`));
  return lines;
}

const testItemName = sampleOrder.cart[0].name;
const testItemPrefix = `${sampleOrder.cart[0].quantity} x `;
const testItemPrice = sampleOrder.cart[0].basePrice;
let mergedName = "";
mergedName += sampleOrder.cart[0].options[0].choices[0].name;
mergedName += `(${sampleOrder.cart[0].options[0].choices[0].subOptions[0].choices[0].name})`;
const testOptionName = mergedName;
const testOptionPrefix = `- `;
const testOptionPrice = sampleOrder.cart[0].options[0].choices[0].extraPrice;

wrapTextWithPrice(testItemName, testItemPrefix, testItemPrice);
wrapTextWithPrice(testOptionName, testOptionPrefix, testOptionPrice, true);
