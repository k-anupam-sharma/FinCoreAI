import os

path = r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\data_manager.py"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

new_func = """
def process_invoice(invoice_id, supplier_id, date, amount):
    try:
        # Check if exists
        res = supabase.table('invoices').select('InvoiceID').eq('InvoiceID', invoice_id).execute()
        if res.data:
            return f"Duplicate Invoice! Invoice {invoice_id} has already been logged."
            
        # Insert
        data = {
            "InvoiceID": invoice_id,
            "PO_ID": "UNKNOWN",
            "SupplierID": supplier_id,
            "InvoiceDate": date,
            "TotalAmount": amount,
            "Status": "Pending",
            "DueDate": date
        }
        supabase.table('invoices').insert(data).execute()
        return f"Invoice {invoice_id} logged successfully! Total: Rs. {amount}"
    except Exception as e:
        return f"Error logging invoice: {str(e)}"
"""

if "def process_invoice" not in content:
    content += new_func
    
with open(path, "w", encoding="utf-8") as f:
    f.write(content)
