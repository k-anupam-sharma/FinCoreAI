with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\data_manager.py", "r", encoding="utf-8") as f:
    content = f.read()

# Fix check_inventory
old_inv = """        if res.data:
            product = res.data[0]
            return f"Product {product_id.upper()}: {product['QuantityInStock']} in stock (Reorder point: {product['ReorderPoint']})\""""
new_inv = """        if res.data:
            product = res.data[0]
            prod_res = supabase.table('products').select('ProductName').eq('ProductID', product_id.upper()).execute()
            prod_name = prod_res.data[0]['ProductName'] if prod_res.data else "Unknown Product"
            return f"Product {product_id.upper()} ({prod_name}): {product['QuantityInStock']} in stock (Reorder point: {product['ReorderPoint']})\""""
content = content.replace(old_inv, new_inv)

# Fix get_purchase_order
old_po = """        if res.data:
            p = res.data[0]
            return f"PO {p['PO_ID']}: Ordered {p['QuantityOrdered']} of {p['ProductID']} from {p['SupplierID']} on {p['PODate']}. Total Cost: Rs.{p['TotalAmountSpent']:,.2f}\""""
new_po = """        if res.data:
            p = res.data[0]
            prod_res = supabase.table('products').select('ProductName').eq('ProductID', p['ProductID']).execute()
            prod_name = prod_res.data[0]['ProductName'] if prod_res.data else "Unknown"
            sup_res = supabase.table('suppliers').select('SupplierName').eq('SupplierID', p['SupplierID']).execute()
            sup_name = sup_res.data[0]['SupplierName'] if sup_res.data else "Unknown"
            return f"PO {p['PO_ID']}: Ordered {p['QuantityOrdered']} of {p['ProductID']} ({prod_name}) from {p['SupplierID']} ({sup_name}) on {p['PODate']}. Total Cost: Rs.{p['TotalAmountSpent']:,.2f}\""""
content = content.replace(old_po, new_po)

# Fix get_product_info
old_prod = """        if p:
            return f"Product {p['ProductID']}: {p['ProductName']} (Category: {p['CategoryID']}, Price: Rs.{p['DefaultSellingPrice']}, Supplier: {p['SupplierID']})\""""
new_prod = """        if p:
            sup_res = supabase.table('suppliers').select('SupplierName').eq('SupplierID', p['SupplierID']).execute()
            sup_name = sup_res.data[0]['SupplierName'] if sup_res.data else "Unknown"
            return f"Product {p['ProductID']}: {p['ProductName']} (Category: {p['CategoryID']}, Price: Rs.{p['DefaultSellingPrice']}, Supplier: {p['SupplierID']} ({sup_name}))\""""
content = content.replace(old_prod, new_prod)

with open(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot\data_manager.py", "w", encoding="utf-8") as f:
    f.write(content)
