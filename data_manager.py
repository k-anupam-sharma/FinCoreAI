import os
from datetime import datetime
from supabase import create_client, Client
from dotenv import load_dotenv

# Load environment variables
load_dotenv()
url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(url, key)

def check_inventory(product_id):
    try:
        res = supabase.table('inventory').select('*').eq('ProductID', product_id.upper()).execute()
        if res.data:
            product = res.data[0]
            prod_res = supabase.table('products').select('ProductName').eq('ProductID', product_id.upper()).execute()
            prod_name = prod_res.data[0]['ProductName'] if prod_res.data else "Unknown Product"
            return f"Product {product_id.upper()} ({prod_name}): {product['QuantityInStock']} in stock (Reorder point: {product['ReorderPoint']})"
        return f"Product {product_id.upper()} not found in inventory."
    except Exception as e:
        return f"Error reading inventory: {str(e)}"

def get_total_sales():
    try:
        # Since we can't sum directly easily without RPC, we pull data and sum it. 
        res = supabase.table('sales_raw').select('TotalAmount').execute()
        total = sum([row['TotalAmount'] for row in res.data])
        return f"Total Sales to date: Rs.{total:,.2f}"
    except Exception as e:
        return f"Error calculating sales: {str(e)}"

def add_expense(expense_code, amount, description):
    try:
        # Get count to generate ExpenseID
        res = supabase.table('expenses').select('*', count='exact').execute()
        count = res.count if res.count else len(res.data)
        expense_id = f"EXP{count+1:03d}"
        
        today = datetime.now().strftime('%Y-%m-%d')
        new_row = {
            'ExpenseID': expense_id,
            'ExpenseDate': today,
            'ExpenseCode': expense_code.upper(),
            'AmountSpent': float(amount),
            'Description': description
        }
        supabase.table('expenses').insert(new_row).execute()
        return f"Added expense {expense_id} for Rs.{amount}."
    except Exception as e:
        return f"Error adding expense: {str(e)}"

def get_invoice_status(invoice_id):
    try:
        res = supabase.table('invoices').select('*').eq('InvoiceID', invoice_id.upper()).execute()
        if res.data:
            inv = res.data[0]
            return f"Invoice {invoice_id.upper()}: Rs.{inv['TotalInvoiceValue']:,.2f} (Status: {inv['Status']}, Date: {inv['InvoiceDate']})"
        return f"Invoice {invoice_id.upper()} not found."
    except Exception as e:
        return f"Error reading invoice: {str(e)}"

def get_customer_info(query):
    try:
        query = query.upper()
        # Search by ID or Name
        res_id = supabase.table('customers').select('*').eq('CustomerID', query).execute()
        if res_id.data:
            c = res_id.data[0]
        else:
            res_name = supabase.table('customers').select('*').ilike('DisplayName', f"%{query}%").execute()
            if res_name.data:
                c = res_name.data[0]
            else:
                return f"Customer '{query}' not found."
                
        return f"Customer {c['CustomerID']}: {c['DisplayName']} (Contact: {c['ContactName']}, Phone: {c['Phone']}, Credit Limit: Rs.{c['CreditLimit']})"
    except Exception as e:
        return f"Error reading customer: {str(e)}"

def get_purchase_order(po_id):
    try:
        res = supabase.table('purchase_orders').select('*').eq('PO_ID', po_id.upper()).execute()
        if res.data:
            p = res.data[0]
            prod_res = supabase.table('products').select('ProductName').eq('ProductID', p['ProductID']).execute()
            prod_name = prod_res.data[0]['ProductName'] if prod_res.data else "Unknown"
            sup_res = supabase.table('suppliers').select('SupplierName').eq('SupplierID', p['SupplierID']).execute()
            sup_name = sup_res.data[0]['SupplierName'] if sup_res.data else "Unknown"
            return f"PO {p['PO_ID']}: Ordered {p['QuantityOrdered']} of {p['ProductID']} ({prod_name}) from {p['SupplierID']} ({sup_name}) on {p['PODate']}. Total Cost: Rs.{p['TotalAmountSpent']:,.2f}"
        return f"Purchase Order {po_id.upper()} not found."
    except Exception as e:
        return f"Error reading PO: {str(e)}"

def check_pending_payments(customer_query=None):
    try:
        if customer_query:
            query = customer_query.upper()
            res_id = supabase.table('customers').select('*').eq('CustomerID', query).execute()
            c = res_id.data[0] if res_id.data else None
            
            if not c:
                res_name = supabase.table('customers').select('*').ilike('DisplayName', f"%{query}%").execute()
                c = res_name.data[0] if res_name.data else None
                
            if c:
                c_id = c['CustomerID']
                res_pending = supabase.table('pending_payments').select('*').eq('CustomerID', c_id).execute()
                if res_pending.data:
                    total = sum([p['AmountPending'] for p in res_pending.data])
                    invoices = ", ".join([p['InvoiceID'] for p in res_pending.data])
                    return f"Customer {c['DisplayName']} ({c_id}) has pending payments totaling Rs.{total:,.2f} across invoices: {invoices}"
                return f"Customer {c['DisplayName']} has no pending payments!"
            return f"Customer '{customer_query}' not found."
        else:
            res = supabase.table('pending_payments').select('*').order('DaysOverdue', desc=True).limit(5).execute()
            out = "Top 5 Overdue Payments:\n"
            for r in res.data:
                out += f"- Invoice {r['InvoiceID']} ({r['CustomerID']}): Rs.{r['AmountPending']:,.2f} ({r['DaysOverdue']} days overdue)\n"
            return out
    except Exception as e:
        return f"Error reading pending payments: {str(e)}"

def get_supplier_info(query):
    try:
        query = query.upper()
        res_id = supabase.table('suppliers').select('*').eq('SupplierID', query).execute()
        s = res_id.data[0] if res_id.data else None
        
        if not s:
            res_name = supabase.table('suppliers').select('*').ilike('SupplierName', f"%{query}%").execute()
            s = res_name.data[0] if res_name.data else None
            
        if s:
            return f"Supplier {s['SupplierID']}: {s['SupplierName']} (Category: {s['PrimaryCategory']}, Contact: {s['ContactPerson']}, Phone: {s['Phone']}, Reliability: {s['ReliabilityScore']}/5)"
        return f"Supplier '{query}' not found."
    except Exception as e:
        return f"Error reading supplier: {str(e)}"

def get_product_info(query):
    try:
        query = query.upper()
        res_id = supabase.table('products').select('*').eq('ProductID', query).execute()
        p = res_id.data[0] if res_id.data else None
        
        if not p:
            res_name = supabase.table('products').select('*').ilike('ProductName', f"%{query}%").execute()
            p = res_name.data[0] if res_name.data else None
            
        if p:
            sup_res = supabase.table('suppliers').select('SupplierName').eq('SupplierID', p['SupplierID']).execute()
            sup_name = sup_res.data[0]['SupplierName'] if sup_res.data else "Unknown"
            return f"Product {p['ProductID']}: {p['ProductName']} (Category: {p['CategoryID']}, Price: Rs.{p['DefaultSellingPrice']}, Supplier: {p['SupplierID']} ({sup_name}))"
        return f"Product '{query}' not found."
    except Exception as e:
        return f"Error reading product: {str(e)}"

def get_table_count(table_name):
    try:
        table_name = table_name.lower().strip()
        valid_tables = ['inventory', 'sales_raw', 'expenses', 'invoices', 'customers', 'purchase_orders', 'pending_payments', 'suppliers', 'products']
        if table_name not in valid_tables:
            return f"Table {table_name} does not exist."
            
        res = supabase.table(table_name).select('*', count='exact').limit(1).execute()
        count = res.count if res.count is not None else 0
        return f"There are {count} records in the {table_name} table."
    except Exception as e:
        return f"Error reading count for {table_name}: {str(e)}"

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
