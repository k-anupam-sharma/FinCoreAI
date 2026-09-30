import data_manager
import json

res = data_manager.supabase.table('expenses').select('*').limit(1).execute()
if res.data:
    print(json.dumps(list(res.data[0].keys())))
else:
    print("No data in expenses")
