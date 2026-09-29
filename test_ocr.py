import os
import base64
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

client = OpenAI(
  base_url="https://integrate.api.nvidia.com/v1",
  api_key=os.environ.get("NVIDIA_API_KEY", "")
)

def extract_invoice_data(image_path: str):
    print(f"Reading image from {image_path}...")
    with open(image_path, "rb") as image_file:
        encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
        
    print("Sending to Llama 3.2 11B Vision Instruct for OCR...")
    response = client.chat.completions.create(
        model="meta/llama-3.2-11b-vision-instruct",
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text", 
                        "text": "Please extract the Invoice ID, Supplier Name, Date, and Total Amount from this invoice. Return ONLY a JSON object in this format: {\"invoice_id\": \"...\", \"supplier\": \"...\", \"date\": \"...\", \"total\": ...}"
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{encoded_string}"
                        }
                    }
                ]
            }
        ],
        max_tokens=200
    )
    
    print("\nExtraction Result:")
    print(response.choices[0].message.content)

if __name__ == "__main__":
    print("Welcome to the OCR Test script!")
    print("Please place a sample invoice image in this folder and type its filename below.")
    filename = input("Filename (e.g. invoice1.jpg): ")
    if os.path.exists(filename):
        extract_invoice_data(filename)
    else:
        print(f"File {filename} not found!")
