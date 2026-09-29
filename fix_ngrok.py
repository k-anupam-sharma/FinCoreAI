path = r"C:\Users\Anupam\AppData\Local\ngrok\ngrok.yml"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace('version: "3"', 'version: "2"')

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
