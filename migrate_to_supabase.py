import os
import pandas as pd
from sqlalchemy import create_engine
from dotenv import load_dotenv

# Load environment variables
load_dotenv()
db_password = os.environ.get("SUPABASE_DB_PASSWORD")

if not db_password:
    print("❌ Error: SUPABASE_DB_PASSWORD not found in .env file!")
    print("Please add it and try again.")
    exit(1)

print("🔗 Connecting to Supabase Database...")
# Direct Supabase Postgres connection string
import urllib.parse
encoded_password = urllib.parse.quote_plus(db_password)
DB_URL = f"postgresql+psycopg2://postgres:{encoded_password}@db.svfwdjxqwmciiokcqosc.supabase.co:5432/postgres"

try:
    engine = create_engine(DB_URL)
    connection = engine.connect()
    print("✅ Connected successfully!\n")
except Exception as e:
    print(f"❌ Failed to connect: {e}")
    exit(1)

# The core CSV files to upload
core_csvs = [
    'inventory.csv', 'sales_raw.csv', 'expenses.csv', 'invoices.csv', 
    'customers.csv', 'purchase_orders.csv', 'pending_payments.csv', 
    'suppliers.csv', 'products.csv'
]

datasets_dir = os.path.join(os.path.dirname(__file__), 'datasets', 'datasets')

print("🚀 Starting Data Migration to Supabase...")

for file in core_csvs:
    file_path = os.path.join(datasets_dir, file)
    table_name = file.replace('.csv', '')
    
    if os.path.exists(file_path):
        try:
            print(f"Uploading {file} to table '{table_name}'...")
            df = pd.read_csv(file_path)
            # Write to SQL (creates table automatically and infers types)
            df.to_sql(table_name, engine, if_exists='replace', index=False)
            print(f"  └─ Success! ({len(df)} rows uploaded)")
        except Exception as e:
            print(f"  └─ ❌ Error uploading {file}: {e}")
    else:
        print(f"⚠️ Warning: {file} not found locally.")

print("\n🎉 Migration Complete! Your data is now live on Supabase!")
