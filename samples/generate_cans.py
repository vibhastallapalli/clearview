#!/usr/bin/env python3
"""
Synthetic soda-can PO and invoices (PROVISIONAL products, see samples/detector/products.proposed.json).

    py -3 samples/generate_cans.py

Writes into samples/docs/:
  cans_po_en.pdf                1 x 6-pack Coca-Cola Classic 12 oz @ $6.00 + 2 x Diet Coke 12 oz can @ $1.00 = $8.00
  cans_invoice_es.png           Same order in Spanish ("1 paquete de 6 latas"), matches the PO
  cans_invoice_es_no_pack.png   "1 caja" with no pack size printed: must NOT become 1 can (needs review)
Expected results: samples/detector/expected-docs.json.
"""
from generate import OUT, INK, MUTED, W, font, page, table


def header(d, title, ref, lines):
    d.text((90, 120), title, font=font(56, True), fill=INK)
    d.text((90, 200), ref, font=font(34, True), fill=INK)
    for i, text in enumerate(lines):
        d.text((90, 260 + 38 * i), text, font=font(26), fill=MUTED)


def purchase_order():
    img, d = page()
    header(d, "PURCHASE ORDER", "PO-1001", ["Date: September 27, 2026", "Buyer: Harbour Street Café (synthetic)", "Supplier: Bebidas del Norte (synthetic)"])
    y = table(
        d, 460,
        ["Item", "Qty", "Unit price", "Amount"],
        [
            ["Coca-Cola Classic 12 fl oz can, 6-pack", "1 pack", "$6.00", "$6.00"],
            ["Diet Coke 12 fl oz can", "2 cans", "$1.00", "$2.00"],
        ],
        [90, 640, 820, 1010],
    )
    d.text((820, y + 30), "Total (USD)", font=font(28, True), fill=INK)
    d.text((1010, y + 30), "$8.00", font=font(28, True), fill=INK)
    return img


def invoice(first_row):
    img, d = page()
    header(d, "FACTURA", "F-2026-0458", ["Fecha: 27 de septiembre de 2026", "Su pedido: PO-1001", "Emisor: Bebidas del Norte (sintético)"])
    y = table(
        d, 460,
        ["Descripción", "Cantidad", "Precio", "Importe"],
        [first_row, ["Coca-Cola Light lata 355 ml", "2 latas", "$1.00/lata", "$2.00"]],
        [90, 700, 850, 1030],
    )
    d.text((850, y + 30), "Total (USD)", font=font(28, True), fill=INK)
    d.text((1030, y + 30), "$8.00", font=font(28, True), fill=INK)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    purchase_order().save(OUT / "cans_po_en.pdf", "PDF", resolution=150)
    invoice(["Coca-Cola Clásica lata 355 ml, paquete de 6", "1 paquete", "$6.00/paq.", "$6.00"]).save(OUT / "cans_invoice_es.png")
    invoice(["Coca-Cola Clásica lata 355 ml", "1 caja", "$6.00/caja", "$6.00"]).save(OUT / "cans_invoice_es_no_pack.png")
    print("wrote cans_po_en.pdf, cans_invoice_es.png, cans_invoice_es_no_pack.png")


if __name__ == "__main__":
    main()
