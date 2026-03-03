import os
import sys
from PIL import Image, ImageOps, ImageChops

def colorize_image(img_rgba, hex_color):
    """
    흰 배경을 날린 이미지의 알파 채널을 유지한 채,
    회색조로 변환한 뒤 입력받은 hex_color 계열로 밝게 틴트를 입힙니다.
    """
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        r, g, b = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
    else:
        r, g, b = (128, 128, 128)

    alpha = img_rgba.split()[3]
    gray = img_rgba.convert('L')
    
    # 색상을 화사하면서도 선명하게 조정 (밝은 보드판 위에서 뚜렷하게 보이도록)
    # 검은 선 매핑: 원래 색의 아주 어두운 버전(거의 검은색)에 가깝게 
    dark_c = (int(r * 0.2), int(g * 0.2), int(b * 0.2))
    # 흰 면 매핑: 파스텔톤이 너무 옅어지지 않도록, 원색에 흰색을 아주 약간만(25%) 섞어주어 선명함 유지
    light_c = (int(r + (255 - r) * 0.25), int(g + (255 - g) * 0.25), int(b + (255 - b) * 0.25))
    
    tinted = ImageOps.colorize(gray, black=dark_c, white=light_c)
    tinted.putalpha(alpha)
    return tinted

def make_transparent_and_clean(img):
    from PIL import ImageDraw
    
    # 건물이 중앙에 위치한다는 것을 가정하고, 가장자리에 있는 모든 노이즈/격자선을 무식하게 흰색으로 덮어버립니다.
    # 좌, 우, 상, 하 여백이 다르므로 각각 알맞은 두께로 덮습니다. (왼쪽 격자선 잔여물 제거)
    draw = ImageDraw.Draw(img)
    w, h = img.size
    wipe_left = 60
    wipe_right = 50
    wipe_top = 40
    wipe_bottom = 45 
    draw.rectangle([0, 0, w, wipe_top], fill=(255, 255, 255, 255))
    draw.rectangle([0, h - wipe_bottom, w, h], fill=(255, 255, 255, 255))
    draw.rectangle([0, 0, wipe_left, h], fill=(255, 255, 255, 255))
    draw.rectangle([w - wipe_right, 0, w, h], fill=(255, 255, 255, 255))

    gray = img.convert('L')
    bw = gray.point(lambda p: 255 if p > 230 else 0)
    
    # 테두리를 모두 흰색으로 덮었으므로, (0,0) 좌표는 무조건 배경(흰색). 여기서 한 번만 floodfill 하면 됩니다.
    ImageDraw.floodfill(bw, (0, 0), 128)
    
    mask = bw.point(lambda p: 0 if p == 128 else 255)
    
    img = img.convert("RGBA")
    img.putalpha(mask)
    return img

def process_buildings(source_path, dest_dir):
    try:
        img = Image.open(source_path).convert('RGBA')
    except Exception as e:
        print(f"이미지 열기 실패: {e}")
        return

    width, height = img.size
    
    # 2x3 그리드 분할: 3열 2행
    cell_w = width // 3
    cell_h = height // 2

    # 그리드 순서 구역 (상단 좌->우, 하단 좌->우)
    # 상단 0, 1, 2 = 의회, 연구소, 광산
    # 하단 0, 1, 2 = 아카데미, 가이아포머, 교역소
    layouts = [
        "planetary_institute", "research_lab", "mine",
        "academy", "gaiaformer", "trading_station"
    ]

    # 건물별 스케일 비율 (1.0 = 캔버스 꽉 채움, 0.7 = 70% 크기로 축소)
    BUILDING_SCALE = {
        "planetary_institute": 0.70,
        "research_lab":        0.60,
        "mine":                0.60,
        "academy":             0.70,
        "gaiaformer":          0.55,
        "trading_station":     0.60,
    }

    # gameConfig.ts에 기반한 종족(행성)별 기준 색상표 + 다카니안/팅커로이드 소행성
    COLORS = {
        'terra': '#3B5998',
        'oxide': '#E65100',
        'volcanic': '#B71C1C',
        'desert': '#F9A825',
        'swamp': '#8B5A2B',    # 갈색(Swamp)을 더 밝고 따뜻한 톤으로 변경하여 구별감 향상 (#4E342E -> #8B5A2B)
        'titanium': '#757575', # 회색(Titanium)을 더 밝은 은회색으로 변경하여 갈색과 대비되게 함 (#424242 -> #757575)
        'ice': '#B3E5FC',
        'proto': '#00E5FF',
        'asteroid': '#AB47BC'  # 소행성 색상 추가
    }

    if not os.path.exists(dest_dir):
        os.makedirs(dest_dir, exist_ok=True)

    # 픽셀에 의존하는 하드코딩된 마진을 제거합니다. 
    # 통일된 캔버스 크기를 260x260 정도로 지정합니다.
    canvas_w = 260
    canvas_h = 260

    for idx, b_name in enumerate(layouts):
        if not b_name:
            continue

        col = idx % 3
        row = idx // 3

        # 영역을 단순히 1/6 그리드로 크게 자릅니다.
        left  = col * cell_w
        upper = row * cell_h
        right = (col + 1) * cell_w
        lower = (row + 1) * cell_h
        cell = img.crop((left, upper, right, lower))

        # 2. 배경 지우기 (가장자리 40px을 무조건 삭제하여 격자선 방어)
        transparent_cell = make_transparent_and_clean(cell)

        # 3. 알맹이(그려진 부분)만 타이트하게 크롭
        bbox = transparent_cell.getbbox()
        if bbox:
            transparent_cell = transparent_cell.crop(bbox)

        # 4. 건물별 스케일 적용 (캔버스 크기 기준 비율로 리사이즈)
        scale = BUILDING_SCALE.get(b_name, 0.75)
        bw, bh = transparent_cell.size
        max_w = int(canvas_w * scale)
        max_h = int(canvas_h * scale)
        ratio = min(max_w / bw, max_h / bh)
        new_w, new_h = int(bw * ratio), int(bh * ratio)
        transparent_cell = transparent_cell.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # 5. 표준 캔버스에 중앙 배치 (모든 건물 동일 크기로 통일)
        # 기본적으로 수직, 수평 중앙에 정렬하되, 교역소(trading_station) 등
        # 바닥면이 넓은 건물이 하늘에 뜨지 않도록 필요시 하단 정렬 처리 가능
        bw, bh = transparent_cell.size
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        paste_x = max(0, (canvas_w - bw) // 2)
        
        # if b_name == "trading_station":
        #     # 교역소 등 형태가 넙적한 모델은 수직으로 중앙에 놓으면 허공에 뜬 것처럼 보임
        #     # 따라서 캔버스의 하단 여백을 조금만 남기고 아래로 내림 (예: 여백 20px)
        #     paste_y = canvas_h - bh - 20
        # else:
        # paste_y = max(0, (canvas_h - bh) // 2)
        paste_y = max(0, (canvas_h - bh) // 2)


        canvas.paste(transparent_cell, (paste_x, paste_y))

        # 6. 색상별로 저장
        for c_name, c_hex in COLORS.items():
            tinted = colorize_image(canvas, c_hex)
            out_filename = f"{c_name}_{b_name}.png"
            out_path = os.path.join(dest_dir, out_filename)
            tinted.save(out_path, "PNG")
            print(f"Saved: {out_path}")

    print("\n✅ 건물 이미지 분할 및 종족별 색상 덧입히기 완료!")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용법: python process_buildings.py [원본이미지경로]")
    else:
        src = sys.argv[1]
        # 에셋은 client/public/image/buildings/ 폴더에 저장
        dest = os.path.join("client", "public", "image", "buildings")
        process_buildings(src, dest)
