const escpos = require("escpos");
escpos.USB = require("escpos-usb");

// 프린터 연결 (Vendor ID: 0x04B8, Product ID: 0x0202)
const device = new escpos.USB(0x04b8, 0x0202);
const printer = new escpos.Printer(device);

// 다국어 텍스트
const koreanText = "안녕하세요"; // 한국어
const chineseText = "你好"; // 중국어 (간체)
const japaneseText = "こんにちは"; // 일본어

device.open((err) => {
  if (err) {
    console.error("Device error:", err);
    return;
  }

  console.log("Printer connected successfully");

  // 프린터 초기화 (ESC @ 명령어로 대체)
  printer.raw(Buffer.from([0x1b, 0x40])); // ESC @ (프린터 초기화)

  // 출력 설정
  printer
    .align("ct")
    .style("bu")
    .size(1, 1)
    .text("Multilingual Test Print")
    .text("-------------------");

  // 한국어 출력 (Code Page 949)
  printer
    .control("ESC t 16") // Code Page 949 (EUC-KR) 설정
    .text("Korean: " + koreanText)
    .text("-------------------");

  // 중국어 출력 (Code Page 936)
  printer
    .control("ESC t 20") // Code Page 936 (GB2312) 설정
    .text("Chinese: " + chineseText)
    .text("-------------------");

  // 일본어 출력 (Code Page 932)
  printer
    .control("ESC t 17") // Code Page 932 (Shift-JIS) 설정
    .text("Japanese: " + japaneseText)
    .text("-------------------");

  // 마무리
  printer
    .text("Test Completed")
    .cut()
    .close((err) => {
      if (err) {
        console.error("Error closing printer:", err);
      } else {
        console.log("Printer closed successfully");
      }
    });

  console.log("Multilingual test print completed");
});
