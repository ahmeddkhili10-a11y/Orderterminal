# Helpers for build.mjs.
#   outline.py pages <pdf>                    -> JSON [[title, page], ...] of every bookmark, in order
#   outline.py merge <cover> <body> <out>     -> cover + body, body bookmarks kept, document info set
import json, sys
import pypdf

def flat(reader, items, out):
    for x in items:
        if isinstance(x, list):
            flat(reader, x, out)
        else:
            out.append([x.title, reader.get_destination_page_number(x) + 1])
    return out

if sys.argv[1] == 'pages':
    r = pypdf.PdfReader(sys.argv[2])
    print(json.dumps(flat(r, r.outline, [])))
elif sys.argv[1] == 'merge':
    cover, body, out = sys.argv[2:5]
    w = pypdf.PdfWriter()
    w.append(cover, import_outline=False)
    top = w.add_outline_item('Cover', 0)
    w.append(body, import_outline=True)
    w.add_metadata({
        '/Title': "Novus Ordo — Operator's Manual",
        '/Author': 'Quincy Gininda',
        '/Subject': 'How to use the Novus Ordo crypto trading terminal',
        '/Creator': 'Novus Ordo',
        '/Keywords': 'Novus Ordo, crypto trading terminal, order flow, quant, strategy lab, crypto swarm, manual',
    })
    w.page_mode = '/UseOutlines'
    with open(out, 'wb') as f:
        w.write(f)
