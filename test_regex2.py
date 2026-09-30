import re
import json

text = """To estimate the impact on sales, let's assume that the order of 140 Global Desi
Palazzo Sets (PROD012) will be placed.

First, let's check the current sales data:

{"name": "get_order_info", "parameters": {"query": "PROD012"}}"""

match = re.search(r'\{.*\}', text.replace('\n', ''))
if match:
    print("MATCH:", match.group(0))
    try:
        parsed = json.loads(match.group(0))
        print("PARSED:", parsed)
    except Exception as e:
        print("PARSE ERROR:", e)
else:
    print("NO MATCH")
