const escpos = require("escpos");
escpos.USB = require("escpos-usb");

// 프린터 설정 (USB 연결)
const device = new escpos.USB(0x04b8, 0x0202); // TM-U220PD의 Vendor ID와 Product ID
const printer = new escpos.Printer(device);

// 테스트 데이터 (영어와 홍콩어)
const testTextEnglish = "Test English";
const testTextChinese = "測試香港字"; // "Test Hong Kong Text"

function log(message) {
  console.log(
    `[${new Date().toLocaleTimeString("en-US", {
      timeZone: "America/Vancouver",
    })}] ${message}`
  );
}

async function testFontSizes() {
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

    // 테스트 1: Code Page 950(Big5) 설정 후 글씨 크기 설정
    printer
      .align("lt")
      .text("Test 1: Code Page 950 + ESC !")
      .text("-----------------------------")
      // 영어 (기본 크기)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(testTextEnglish)
      // 영어 (2배 높이)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(testTextEnglish)
      // 한자 (기본 크기)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(testTextChinese)
      // 한자 (2배 높이)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(testTextChinese)
      .text("\n\n");

    // 테스트 2: Code Page Latin I (1252) + 유니코드 출력
    printer
      .text("Test 2: Code Page 1252 + Unicode")
      .text("-----------------------------")
      // 영어 (기본 크기)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(testTextEnglish)
      // 영어 (2배 높이)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(testTextEnglish)
      // 한자 (기본 크기)
      .raw(Buffer.from([0x1b, 0x74, 0x13])) // ESC t 0x13 (Code Page 1252, Latin I)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(testTextChinese)
      // 한자 (2배 높이)
      .raw(Buffer.from([0x1b, 0x74, 0x13])) // ESC t 0x13 (Code Page 1252, Latin I)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(testTextChinese)
      .text("\n\n");

    // 테스트 3: Raw 명령어로 직접 인코딩
    printer
      .text("Test 3: Raw Encoding")
      .text("-----------------------------")
      // 영어 (기본 크기)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(testTextEnglish)
      // 영어 (2배 높이)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(testTextEnglish)
      // 한자 (기본 크기, Big5 인코딩)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .raw(Buffer.from([0xb4, 0x4b, 0xb5, 0x4b, 0xb4, 0x4b, 0xb5, 0x4b])) // "測試" in Big5
      .text("")
      // 한자 (2배 높이, Big5 인코딩)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .raw(Buffer.from([0xb4, 0x4b, 0xb5, 0x4b, 0xb4, 0x4b, 0xb5, 0x4b])) // "測試" in Big5
      .text("")
      .text("\n\n");

    // 테스트 4: 폰트 설정(ESC M) + 글씨 크기 설정(ESC !)
    printer
      .text("Test 4: ESC M + ESC !")
      .text("-----------------------------")
      // 영어 (기본 크기, FontA)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x4d, 0x00])) // ESC M 0 (FontA)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(testTextEnglish)
      // 영어 (2배 높이, FontA)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1b, 0x4d, 0x00])) // ESC M 0 (FontA)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(testTextEnglish)
      // 한자 (기본 크기, FontA)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1b, 0x4d, 0x00])) // ESC M 0 (FontA)
      .raw(Buffer.from([0x1b, 0x21, 0x00])) // ESC ! 0x00 (기본 크기)
      .text(testTextChinese)
      // 한자 (2배 높이, FontA)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1b, 0x4d, 0x00])) // ESC M 0 (FontA)
      .raw(Buffer.from([0x1b, 0x21, 0x10])) // ESC ! 0x10 (2배 높이)
      .text(testTextChinese)
      .text("\n\n");

    // 테스트 5: GS ! 명령어로 글씨 크기 설정
    printer
      .text("Test 5: GS !")
      .text("-----------------------------")
      // 영어 (기본 크기)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1d, 0x21, 0x00])) // GS ! 0x00 (기본 크기)
      .text(testTextEnglish)
      // 영어 (2배 높이)
      .raw(Buffer.from([0x1b, 0x74, 0x00])) // ESC t 0 (PC437)
      .raw(Buffer.from([0x1d, 0x21, 0x10])) // GS ! 0x10 (2배 높이)
      .text(testTextEnglish)
      // 한자 (기본 크기)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1d, 0x21, 0x00])) // GS ! 0x00 (기본 크기)
      .text(testTextChinese)
      // 한자 (2배 높이)
      .raw(Buffer.from([0x1b, 0x74, 0x15])) // ESC t 0x15 (Code Page 950, Big5)
      .raw(Buffer.from([0x1d, 0x21, 0x10])) // GS ! 0x10 (2배 높이)
      .text(testTextChinese)
      .text("\n\n");

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

    log("Font size test completed");
  } catch (error) {
    log(`Error during font size test: ${error.message}`);
  }
}

// 스크립트 실행 시 바로 테스트
(async () => {
  log("Starting font size test...");
  await testFontSizes();
  log("Test completed");
})();
