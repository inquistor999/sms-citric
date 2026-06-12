// ============================================================
// BU KOD GOOGLE SHEETS ICHIDA ISHLATILADI (Node.js EMAS!)
// Google Sheets → Extensions → Apps Script → bu kodni joylashtiring
// ============================================================

// Qaysi Sheet ishlatilishini belgilash
var SHEET_NAME = 'SMS';

// ============================================================
// MacroDroid dan SMS qabul qilish (POST)
// ============================================================
function doPost(e) {
  try {
    var data;
    
    // JSON body yoki form data ni o'qish
    if (e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      data = e.parameter;
    }
    
    var text = data.text || '';
    var sender = data.sender || 'Unknown';
    var timestamp = data.time || new Date().toISOString();
    
    // SMS matnini tekshirish — faqat "Postupil" bilan boshlanganlari (katta yoki kichik harfligidan qat'iy nazar)
    if (!text.trim().toLowerCase().startsWith('postupil')) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'ignored', reason: 'Postupil bilan boshlanmagan' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    // Google Sheets ga yozish
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    
    // Agar "SMS" sheet yo'q bo'lsa, yaratamiz
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['Timestamp', 'Sender', 'Text']);
    }
    
    // SMS ni qo'shish
    sheet.appendRow([timestamp, sender, text]);
    
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'success', message: 'SMS saved to sheet' })
    ).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: error.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// Bot dan SMS larni o'qish va tozalash (GET)
// ============================================================
function doGet(e) {
  try {
    var action = (e.parameter && e.parameter.action) ? e.parameter.action : 'read';
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success', data: [], count: 0 })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    // ============================================================
    // action=readAndClear — SMS larni o'qib, sheet ni tozalash
    // ============================================================
    if (action === 'readAndClear') {
      var lastRow = sheet.getLastRow();
      
      // Agar header dan boshqa qator yo'q bo'lsa
      if (lastRow <= 1) {
        return ContentService.createTextOutput(
          JSON.stringify({ status: 'success', data: [], count: 0 })
        ).setMimeType(ContentService.MimeType.JSON);
      }
      
      // Barcha SMS qatorlarini o'qish (header dan keyin)
      var dataRange = sheet.getRange(2, 1, lastRow - 1, 3);
      var values = dataRange.getValues();
      
      var smsList = [];
      for (var i = 0; i < values.length; i++) {
        if (values[i][2] && values[i][2].toString().trim() !== '') {
          smsList.push({
            timestamp: values[i][0],
            sender: values[i][1],
            text: values[i][2]
          });
        }
      }
      
      // Sheet ni tozalash (header qoladi)
      if (lastRow > 1) {
        sheet.deleteRows(2, lastRow - 1);
      }
      
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success', data: smsList, count: smsList.length })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    // ============================================================
    // action=read — faqat o'qish (o'chirmasdan)
    // ============================================================
    if (action === 'read') {
      var lastRow = sheet.getLastRow();
      
      if (lastRow <= 1) {
        return ContentService.createTextOutput(
          JSON.stringify({ status: 'success', data: [], count: 0 })
        ).setMimeType(ContentService.MimeType.JSON);
      }
      
      var dataRange = sheet.getRange(2, 1, lastRow - 1, 3);
      var values = dataRange.getValues();
      
      var smsList = [];
      for (var i = 0; i < values.length; i++) {
        if (values[i][2] && values[i][2].toString().trim() !== '') {
          smsList.push({
            timestamp: values[i][0],
            sender: values[i][1],
            text: values[i][2]
          });
        }
      }
      
      return ContentService.createTextOutput(
        JSON.stringify({ status: 'success', data: smsList, count: smsList.length })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: 'Unknown action: ' + action })
    ).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: 'error', message: error.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
