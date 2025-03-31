const escpos = require("escpos");
escpos.USB = require("escpos-usb");

// Vendor ID와 Product ID를 사용하여 프린터 연결
const device = new escpos.USB(0x04b8, 0x0202); // TM-U220PD의 Vendor ID와 Product ID
const printer = new escpos.Printer(device);

// 프린터 연결 및 테스트 인쇄
device.open((err) => {
  if (err) {
    console.error("Device error:", err);
    return;
  }

  console.log("Printer connected successfully");

  printer
    .font("a") // 폰트 설정
    .align("ct") // 중앙 정렬
    .style("bu") // 볼드 및 밑줄 스타일
    .size(1, 1) // 텍스트 크기 (1x1)
    .text("Test Print") // 테스트 텍스트
    .text("-------------------")
    .text("Epson TM-U220PD")
    .text("Windows USB Test")
    .text("-------------------")
    .text("Date: 2025-03-29")
    .cut() // 용지 절단
    .close((err) => {
      if (err) {
        console.error("Error closing printer:", err);
      } else {
        console.log("Printer closed successfully");
      }
    });

  console.log("Test print completed");
});
