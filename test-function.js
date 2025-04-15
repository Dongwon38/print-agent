const testItemName =
  "Omelette with Shredded Ham / 鮮茄火腿蘑菇庵列 + 鮮茄火腿蘑菇庵列鮮茄火腿蘑菇庵列火腿絲通粉";
const testPrice = "123.45";
const testPrefix = "1 x ";
const testOptionName = "Omelette with Shredded Ham / 鮮茄火腿蘑菇庵列 + 鮮茄火腿蘑菇庵列鮮茄火腿蘑菇庵列火腿絲通粉";
const testOptionPrefix = "- ";
const testOptionPrice = "10.00";
const MAX_LINE_CHARS = 48;

function formatPrice(price) {
  const priceStr = price.toString();
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

wrapTextWithPrice(testItemName, testPrefix, testPrice);
wrapTextWithPrice(testOptionName, testOptionPrefix, testOptionPrice);
