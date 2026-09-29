import os
import sys

os.chdir(r"c:\Users\Anupam\Desktop\antigravity projects\SME WhatsApp bot")
sys.path.append(os.getcwd())

from bot import process_message

try:
    print("Testing process_message...")
    reply = process_message("how many suppliers do we have?")
    print("REPLY:", reply)
except Exception as e:
    import traceback
    traceback.print_exc()
