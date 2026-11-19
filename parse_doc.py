# 本地文档取文本（宿主 side 用 python 调）：pdf / docx / txt
# 输出一行 JSON：{ok, chars, text} 或 {ok:false, error}
import sys, json, os

# 宿主读的是字节流，统一按 UTF-8 输出（Windows 控制台默认 GBK 会花屏）
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': '缺少文件路径'}, ensure_ascii=False))
        return
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    text = ''
    try:
        if ext == '.pdf':
            import fitz  # PyMuPDF
            doc = fitz.open(path)
            parts = []
            for page in doc:
                try:
                    parts.append(page.get_text('text') or '')
                except Exception:
                    parts.append('')
            text = '\n'.join(parts)
            doc.close()
        elif ext == '.docx':
            import docx  # python-docx
            d = docx.Document(path)
            parts = [p.text for p in d.paragraphs]
            for t in d.tables:
                for row in t.rows:
                    cells = []
                    for c in row.cells:
                        cells.append(c.text.replace('\n', ' ').strip())
                    parts.append('\t'.join(cells))
            text = '\n'.join(parts)
        elif ext in ('.txt', '.md', '.csv'):
            with open(path, encoding='utf-8', errors='ignore') as fh:
                text = fh.read()
        else:
            text = ''
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, ensure_ascii=False))
        return
    text = (text or '').strip()
    print(json.dumps({'ok': True, 'chars': len(text), 'text': text[:200000]}, ensure_ascii=False))

main()
