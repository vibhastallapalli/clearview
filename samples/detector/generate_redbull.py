"""Generate clearly synthetic PO/invoice images; no detector accuracy claim."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(__file__).resolve().parent
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 28)
for filename, title in [('redbull_po.png', 'PURCHASE ORDER'), ('redbull_invoice.png', 'INVOICE')]:
    image = Image.new('RGB', (1400, 650), 'white')
    draw = ImageDraw.Draw(image)
    lines = ['SYNTHETIC TEST DOCUMENT - NOT A REAL ORDER', title, 'Reference: RB-TEST-001',
             'Supplier: Synthetic Drinks Supplier', 'Currency: USD', '',
             '3 cans | Red Bull Original 250 ml | USD 2.50 per can | USD 7.50',
             '2 cans | Red Bull Sugarfree 250 ml | USD 2.75 per can | USD 5.50',
             '', 'TOTAL: USD 13.00', 'No tax, shipping, discounts or payment address.']
    for i, line in enumerate(lines):
        draw.text((45, 35 + i * 49), line, font=font, fill='black')
    image.save(out / filename)
