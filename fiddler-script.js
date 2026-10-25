/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   CLASSIN PDF AUTO-SAVER - Fiddler Script                ║
 * ║                                                          ║
 * ║   Dùng với Fiddler Classic (miễn phí trên Windows)       ║
 * ║   Tự động bắt và lưu PDF từ Classin Desktop App         ║
 * ╚══════════════════════════════════════════════════════════╝
 * 
 * HƯỚNG DẪN CÀI ĐẶT:
 * 
 * 1. Tải Fiddler Classic: https://www.telerik.com/download/fiddler
 * 2. Cài đặt và mở Fiddler
 * 3. Bật HTTPS Decryption:
 *    - Vào Tools → Options → HTTPS tab
 *    - Check "Decrypt HTTPS traffic"
 *    - Check "Ignore server certificate errors"
 *    - Click OK và cài certificate khi được hỏi
 * 4. Vào Rules → Customize Rules (hoặc Ctrl+R)
 * 5. Copy nội dung file fiddler-rules.txt vào FiddlerScript editor
 * 6. Lưu (Ctrl+S)
 * 7. Mở Classin Desktop App và mở homework
 * 8. PDF sẽ tự động được lưu vào thư mục Downloads\ClassinPDFs
 */

// ============================================================
// BẮT ĐẦU FIDDLER SCRIPT - Copy từ đây
// ============================================================

const FIDDLER_SCRIPT = `
// ===== CLASSIN PDF AUTO-SAVER =====
// Paste đoạn code này vào Fiddler: Rules → Customize Rules
// Tìm function OnBeforeResponse và thêm vào bên trong

// Thêm vào đầu file (phần import)
import System.IO;

// Thêm vào trong class Handlers:

// Thư mục lưu PDF
static var sSavePath: String = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + "\\\\Downloads\\\\ClassinPDFs\\\\";

static function OnBeforeResponse(oSession: Session) {
    // Chỉ xử lý response thành công
    if (oSession.responseCode != 200) return;
    
    // Lấy Content-Type
    var sContentType = oSession.oResponse["Content-Type"];
    var sUrl = oSession.fullUrl;
    
    // Kiểm tra xem có phải PDF không
    var bIsPDF = false;
    var sFilename = "";
    
    // Check 1: Content-Type là PDF
    if (sContentType != null && sContentType.Contains("application/pdf")) {
        bIsPDF = true;
    }
    
    // Check 2: URL chứa .pdf
    if (sUrl.ToLower().Contains(".pdf")) {
        bIsPDF = true;
    }
    
    // Check 3: Content-Disposition chứa .pdf
    var sDisposition = oSession.oResponse["Content-Disposition"];
    if (sDisposition != null && sDisposition.ToLower().Contains(".pdf")) {
        bIsPDF = true;
    }
    
    // Check 4: Cloud storage URL + octet-stream (có thể là PDF ẩn)
    if (sContentType != null && sContentType.Contains("octet-stream")) {
        if (sUrl.Contains("eeo.cn") || sUrl.Contains("aliyuncs.com") || 
            sUrl.Contains("myqcloud.com") || sUrl.Contains("amazonaws.com")) {
            // Kiểm tra magic bytes
            var arrBytes = oSession.responseBodyBytes;
            if (arrBytes != null && arrBytes.Length > 5) {
                var sHeader = System.Text.Encoding.ASCII.GetString(arrBytes, 0, 5);
                if (sHeader == "%PDF-") {
                    bIsPDF = true;
                }
            }
        }
    }
    
    if (!bIsPDF) return;
    
    // Trích xuất tên file
    if (sDisposition != null) {
        var match = System.Text.RegularExpressions.Regex.Match(
            sDisposition, "filename[*]?=(?:UTF-8''|\\"?)([^\\";\n]+)"
        );
        if (match.Success) {
            sFilename = match.Groups[1].Value;
            try { sFilename = System.Uri.UnescapeDataString(sFilename); } catch(e) {}
        }
    }
    
    if (sFilename == "") {
        try {
            var uri = new System.Uri(sUrl);
            sFilename = System.IO.Path.GetFileName(uri.LocalPath);
        } catch(e) {}
    }
    
    if (sFilename == "" || !sFilename.ToLower().EndsWith(".pdf")) {
        sFilename = "classin_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".pdf";
    }
    
    // Sanitize filename
    var invalidChars = System.IO.Path.GetInvalidFileNameChars();
    for (var i = 0; i < invalidChars.Length; i++) {
        sFilename = sFilename.Replace(invalidChars[i].ToString(), "_");
    }
    
    // Tạo thư mục nếu chưa có
    if (!System.IO.Directory.Exists(sSavePath)) {
        System.IO.Directory.CreateDirectory(sSavePath);
    }
    
    // Lưu file
    var sFullPath = sSavePath + sFilename;
    
    // Tránh ghi đè
    var counter = 1;
    while (System.IO.File.Exists(sFullPath)) {
        var ext = System.IO.Path.GetExtension(sFilename);
        var baseName = System.IO.Path.GetFileNameWithoutExtension(sFilename);
        sFullPath = sSavePath + baseName + " (" + counter + ")" + ext;
        counter++;
    }
    
    oSession.SaveResponseBody(sFullPath);
    
    FiddlerApplication.Log.LogString(
        "📥 CLASSIN PDF SAVED: " + sFullPath + 
        " (" + oSession.responseBodyBytes.Length + " bytes)"
    );
}
`;

console.log(FIDDLER_SCRIPT);
console.log('\n// ============================================================');
console.log('// Xem file fiddler-rules.txt để copy FiddlerScript');
console.log('// ============================================================');
