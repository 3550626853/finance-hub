# -*- coding: utf-8 -*-
"""生成手机访问二维码（供 启动平台(手机访问).bat 调用）

用法：python tools/gen-qr.py <url> <输出图片路径>

依赖：qrcode + Pillow（已随平台环境准备）；缺失时脚本静默退出，不影响启动流程。
"""
import sys, os

def main():
    if len(sys.argv) < 3:
        print("用法: python tools/gen-qr.py <url> <out.png>")
        return 2
    url, out = sys.argv[1], sys.argv[2]
    try:
        import qrcode
        from PIL import Image, ImageDraw, ImageFont
    except Exception as e:
        print(f"缺少依赖（{e}），已跳过二维码生成")
        return 1

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=14, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#111827", back_color="white").convert("RGB")

    w, h = img.size
    pad, foot = 28, 132
    canvas = Image.new("RGB", (w + pad * 2, h + foot + pad), "white")
    canvas.paste(img, (pad, pad))
    d = ImageDraw.Draw(canvas)

    def font(sz, bold=False):
        cands = ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc"] if bold \
            else ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]
        for p in cands:
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
        return ImageFont.load_default()

    rows = [
        ("金融信息聚合平台", font(32, True), "#111827"),
        ("手机与电脑连同一 Wi-Fi，扫码即可打开", font(20), "#6b7280"),
        (url, font(26, True), "#2563eb"),
    ]
    y = h + pad + 6
    for text, f, color in rows:
        bb = d.textbbox((0, 0), text, font=f)
        d.text(((canvas.size[0] - (bb[2] - bb[0])) // 2, y), text, fill=color, font=f)
        y += bb[3] - bb[1] + 14

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    canvas.save(out)
    print(f"二维码已生成: {out}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
