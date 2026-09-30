import test_ocr
import sys
try:
    test_ocr.extract_invoice_data("dummy.png")
except Exception as e:
    print("ERROR:", str(e))
