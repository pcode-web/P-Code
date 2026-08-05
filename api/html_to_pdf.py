#!/usr/bin/env python3
"""
Convert HTML to PDF preserving all content including XAI visualizations
Uses ReportLab with enhanced table styling
"""

import sys
import json
import os
import re
import html as html_lib
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch, mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image


def _fully_unescape(text):
    """Decode HTML entities until stable (handles &amp;amp; from double-encoding)."""
    t = str(text or '')
    for _ in range(5):
        nxt = html_lib.unescape(t)
        if nxt == t:
            break
        t = nxt
    return t


def _strip_html_keep_breaks(fragment):
    """Strip HTML tags but keep <br> as newlines; decode entities."""
    text = re.sub(r'<br\s*/?\s*>', '\n', str(fragment or ''), flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = _fully_unescape(text)
    lines = [re.sub(r'[ \t]+', ' ', ln).strip() for ln in text.split('\n')]
    while lines and lines[0] == '':
        lines.pop(0)
    while lines and lines[-1] == '':
        lines.pop()
    # Collapse runs of blank lines to a single blank (paragraph gap)
    out = []
    blank = False
    for ln in lines:
        if ln == '':
            if not blank and out:
                out.append('')
            blank = True
        else:
            out.append(ln)
            blank = False
    return '\n'.join(out)


def _pdf_esc(text):
    """Escape plain text for ReportLab Paragraph markup (decode entities first)."""
    t = _fully_unescape(text)
    return (
        t.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('\n', '<br/>')
    )


def extract_sections(html):
    """Extract all div.section blocks (including class='section section-cover')."""
    sections = []
    # Match class attributes that include the token "section" (cover + numbered sections)
    for m in re.finditer(
        r'<div\b[^>]*\bclass\s*=\s*["\']([^"\']*\bsection\b[^"\']*)["\'][^>]*>',
        html,
        re.IGNORECASE,
    ):
        classes = m.group(1).lower().split()
        if 'section' not in classes:
            continue
        div_start = m.start()
        lower = html.lower()
        i = div_start
        depth = 0
        end = None
        while i < len(lower):
            next_open = lower.find('<div', i)
            next_close = lower.find('</div>', i)
            if next_close < 0:
                break
            if next_open >= 0 and next_open < next_close:
                depth += 1
                i = next_open + 4
            else:
                depth -= 1
                i = next_close + 6
                if depth == 0:
                    end = i
                    break
        if end is None:
            continue
        gt = html.find('>', div_start)
        if gt < 0:
            continue
        sections.append(html[gt + 1:end - 6])
    return sections


def extract_table_data(table_html):
    """Extract table rows and cells, handling colspan, headers, and group rows."""
    data = []
    row_pattern = r'<tr([^>]*)>(.*?)</tr>'

    for row_match in re.finditer(row_pattern, table_html, re.DOTALL | re.IGNORECASE):
        row_attrs = row_match.group(1) or ''
        row_html = row_match.group(2)
        row_is_group = bool(re.search(r'pcode-group-row', row_attrs, re.IGNORECASE))
        cells = []
        has_th = False

        # Match th/td with or without attributes
        cell_pattern = r'<t([hd])(\s+[^>]*)?>(.*?)</t\1>'
        for cell_match in re.finditer(cell_pattern, row_html, re.DOTALL | re.IGNORECASE):
            tag = cell_match.group(1).lower()
            attributes = cell_match.group(2) or ''
            cell_text = _strip_html_keep_breaks(cell_match.group(3))
            if tag == 'h':
                has_th = True

            colspan_match = re.search(r'colspan\s*=\s*["\']?(\d+)["\']?', attributes, re.IGNORECASE)
            colspan = int(colspan_match.group(1)) if colspan_match else 1

            text_align = 'left'
            style_match = re.search(r'style\s*=\s*["\']([^"\']*)["\']', attributes, re.IGNORECASE)
            style_content = style_match.group(1) if style_match else ''
            if 'text-align' in style_content.lower():
                align_match = re.search(r'text-align\s*:\s*(\w+)', style_content, re.IGNORECASE)
                if align_match:
                    text_align = align_match.group(1).lower()

            is_group_cell = (
                row_is_group
                or 'pcode-group-cell' in attributes
                or ('background:#ececec' in style_content.replace(' ', '').lower())
                or ('background:#f5f5f5' in style_content.replace(' ', '').lower())
                or ('background:#f7f7f7' in style_content.replace(' ', '').lower())
            )

            cells.append({
                'text': cell_text if cell_text else '&nbsp;',
                'colspan': colspan,
                'text_align': text_align,
                'is_header': tag == 'h',
                'is_group': is_group_cell,
            })

        if cells:
            # Group banner rows: full-width colspan or labeled A./B./...
            first_text = re.sub(r'\s+', ' ', cells[0]['text']).strip()
            looks_like_group = bool(re.match(r'^[A-F]\.\s+', first_text)) or bool(
                re.match(r'^\d+\.\s+[A-Z]', first_text)
            )
            is_group_row = row_is_group or any(c.get('is_group') for c in cells) or (
                cells[0]['colspan'] > 1 and looks_like_group
            )
            row_is_ob_final = bool(re.search(r'pcode-ob-final-row', row_attrs, re.IGNORECASE)) or (
                'Final Diagnosis (OB-GYN)' in first_text if cells else False
            )
            data.append({
                'cells': cells,
                'is_header_row': has_th and not is_group_row,
                'is_group_row': is_group_row,
                'is_ob_final_row': row_is_ob_final,
            })

    return data


def _build_bordered_table(table_data, styles, table_count):
    """Build a ReportLab Table: borders only on section/column/group headers, not body grid."""
    header_style = ParagraphStyle(
        f'TableHeader_{table_count}',
        parent=styles['Normal'],
        fontSize=9,
        fontName='Helvetica-Bold',
        textColor=colors.black,
        alignment=TA_LEFT,
        leading=11,
        spaceBefore=0,
        spaceAfter=0,
    )
    body_style = ParagraphStyle(
        f'TableBody_{table_count}',
        parent=styles['Normal'],
        fontSize=9,
        fontName='Helvetica',
        textColor=colors.black,
        alignment=TA_LEFT,
        leading=11,
        spaceBefore=0,
        spaceAfter=0,
    )
    center_style = ParagraphStyle(
        f'TableCenter_{table_count}',
        parent=styles['Normal'],
        fontSize=9,
        fontName='Helvetica',
        textColor=colors.black,
        alignment=TA_CENTER,
        leading=11,
        spaceBefore=0,
        spaceAfter=0,
    )
    group_style = ParagraphStyle(
        f'TableGroup_{table_count}',
        parent=styles['Normal'],
        fontSize=9,
        fontName='Helvetica-Bold',
        textColor=colors.black,
        alignment=TA_LEFT,
        leading=11,
        spaceBefore=0,
        spaceAfter=0,
    )

    max_cols = max(
        sum(cell['colspan'] for cell in row['cells']) for row in table_data
    ) if table_data else 1

    para_data = []
    span_commands = []
    group_rows = []
    header_rows = []
    ob_final_rows = []

    for row_idx, row in enumerate(table_data):
        para_row = []
        col_idx = 0
        is_group = row.get('is_group_row', False)
        is_ob_final = row.get('is_ob_final_row', False)
        # Only real <th> rows (or detected column-label rows) get header rules — not body/checklist rows
        is_header = row.get('is_header_row', False)
        if not is_header and not is_group and not is_ob_final and row_idx == 0:
            labels = [re.sub(r'\s+', ' ', c['text']).strip() for c in row['cells']]
            label_like = [
                x for x in labels
                if x and x not in ('&nbsp;', '—', '-') and not x.startswith('[ ]')
            ]
            if label_like and all(re.match(r'^[A-Z0-9][A-Z0-9 /.&%()\-]{0,48}$', x) for x in label_like):
                is_header = True
        if is_group:
            group_rows.append(row_idx)
        if is_header:
            header_rows.append(row_idx)
        if is_ob_final:
            ob_final_rows.append(row_idx)

        for cell in row['cells']:
            cell_text = cell['text']
            colspan = cell['colspan']
            cell_align = cell.get('text_align', 'left').lower()

            # Preserve line breaks; escape once for ReportLab (avoids &amp;amp; / lost ':')
            if not cell_text or cell_text == '&nbsp;':
                safe_text = '&nbsp;'
            elif cell_text.lstrip().startswith('Validated by'):
                # Larger heading line for signature block
                lines = cell_text.split('\n')
                head = _pdf_esc(lines[0].strip())
                rest = '<br/>'.join(_pdf_esc(ln) for ln in lines[1:] if ln.strip())
                safe_text = f'<font size="12"><b>{head}</b></font>'
                if rest:
                    safe_text += '<br/>' + rest
            elif cell_text.lstrip().startswith('Clinical Recommendations'):
                lines = cell_text.split('\n')
                head = _pdf_esc(lines[0].strip())
                rest = '<br/>'.join(_pdf_esc(ln) for ln in lines[1:])
                safe_text = f'<font size="11"><b>{head}</b></font>'
                if rest:
                    safe_text += '<br/>' + rest
            else:
                safe_text = _pdf_esc(cell_text)
            if is_group:
                para_row.append(Paragraph(safe_text, group_style))
            elif is_header or cell.get('is_header'):
                para_row.append(Paragraph(safe_text, header_style))
            elif cell_align == 'center':
                para_row.append(Paragraph(safe_text, center_style))
            else:
                para_row.append(Paragraph(safe_text, body_style))

            if colspan > 1:
                span_commands.append(('SPAN', (col_idx, row_idx), (col_idx + colspan - 1, row_idx)))
            col_idx += colspan

        while len(para_row) < max_cols:
            para_row.append(Paragraph('', body_style))
        para_data.append(para_row)

    # Prefer lab-like column proportions for 2- and 4-column result tables
    if max_cols == 2:
        # Screening results (Result Item | Finding) and patient info tables
        first_label = ''
        if table_data and table_data[0].get('cells'):
            first_label = re.sub(r'\s+', ' ', table_data[0]['cells'][0].get('text', '')).strip().upper()
        if first_label in ('RESULT ITEM', 'FIELD'):
            col_widths = [4.1 * inch, 3.4 * inch]
        else:
            col_widths = [2.85 * inch, 4.65 * inch]
    elif max_cols == 4:
        col_widths = [2.55 * inch, 1.65 * inch, 1.2 * inch, 2.1 * inch]
    else:
        col_width = (7.5 * inch) / max_cols if max_cols > 0 else 7.5 * inch
        col_widths = [col_width] * max_cols

    t = Table(para_data, colWidths=col_widths, repeatRows=1 if header_rows else 0)
    table_style = list(span_commands)
    # No outer BOX / INNERGRID on data tables — only header rules
    table_style.extend([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 3),
        ('RIGHTPADDING', (0, 0), (-1, -1), 3),
        ('TOPPADDING', (0, 0), (-1, -1), 1),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
        ('BACKGROUND', (0, 0), (-1, -1), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
    ])

    for hr in header_rows:
        table_style.extend([
            ('BACKGROUND', (0, hr), (-1, hr), colors.white),
            ('FONTNAME', (0, hr), (-1, hr), 'Helvetica-Bold'),
            ('LINEABOVE', (0, hr), (-1, hr), 1.0, colors.black),
            ('LINEBELOW', (0, hr), (-1, hr), 1.0, colors.black),
            ('TOPPADDING', (0, hr), (-1, hr), 3),
            ('BOTTOMPADDING', (0, hr), (-1, hr), 3),
        ])

    for gr in group_rows:
        table_style.extend([
            ('BACKGROUND', (0, gr), (-1, gr), colors.white),
            ('FONTNAME', (0, gr), (-1, gr), 'Helvetica-Bold'),
            # Thinner top/bottom rules only for A–F subgroup partitions
            ('LINEABOVE', (0, gr), (-1, gr), 0.5, colors.HexColor('#666666')),
            ('LINEBELOW', (0, gr), (-1, gr), 0.5, colors.HexColor('#666666')),
            ('TOPPADDING', (0, gr), (-1, gr), 3),
            ('BOTTOMPADDING', (0, gr), (-1, gr), 3),
        ])

    for obr in ob_final_rows:
        table_style.extend([
            ('BACKGROUND', (0, obr), (-1, obr), colors.white),
            ('FONTNAME', (0, obr), (0, obr), 'Helvetica-Bold'),
            ('LINEABOVE', (0, obr), (-1, obr), 0.5, colors.HexColor('#666666')),
            ('LINEBELOW', (0, obr), (-1, obr), 0.5, colors.HexColor('#666666')),
            ('TOPPADDING', (0, obr), (-1, obr), 3),
            ('BOTTOMPADDING', (0, obr), (-1, obr), 3),
        ])

    t.setStyle(TableStyle(table_style))
    return t

def _load_image_flowable(src, max_w=3.3 * inch, max_h=3.0 * inch):
    """Load a data-URI or file image scaled for the PDF."""
    try:
        img_flowable = None
        if src.startswith('data:image'):
            import base64, io
            _, b64 = src.split(',', 1)
            raw = base64.b64decode(b64)
            img_flowable = Image(io.BytesIO(raw))
        elif os.path.exists(src):
            img_flowable = Image(src)
        elif src.startswith('http://') or src.startswith('https://') or src.startswith('/'):
            local = src
            if src.startswith('/'):
                local = os.path.join(
                    os.path.dirname(os.path.dirname(__file__)),
                    src.lstrip('/').replace('/', os.sep),
                )
            if os.path.exists(local):
                img_flowable = Image(local)
        if img_flowable is None:
            return None
        iw = float(getattr(img_flowable, 'imageWidth', max_w) or max_w)
        ih = float(getattr(img_flowable, 'imageHeight', max_h) or max_h)
        scale = min(max_w / iw, max_h / ih, 1.0)
        img_flowable.drawWidth = iw * scale
        img_flowable.drawHeight = ih * scale
        return img_flowable
    except Exception:
        return None


def _process_cover_header(section_html, styles):
    """Short system header for the first page (P-Code / PMOS)."""
    elements = []
    brand = re.search(
        r'class=["\']brand-name["\'][^>]*>([^<]+)',
        section_html,
        re.IGNORECASE,
    )
    brand_name = html_lib.unescape(brand.group(1)).strip() if brand else 'P-Code'
    subs = [
        html_lib.unescape(m.group(1)).strip()
        for m in re.finditer(r'class=["\']brand-sub["\'][^>]*>([^<]+)', section_html, re.IGNORECASE)
        if m.group(1).strip()
    ]
    meta_raw = 'FOR PATIENT & PHYSICIAN REVIEW'
    meta_block = re.search(r'class=["\']clinic-meta["\'][^>]*>(.*?)</td>', section_html, re.IGNORECASE | re.DOTALL)
    if meta_block:
        # Keep <br> so "Generated:" / "Report ID:" stay on their own lines
        meta_text = _strip_html_keep_breaks(meta_block.group(1))
        if meta_text:
            meta_raw = meta_text

    # Purple brand name to match lab reference PDF
    left_parts = [
        f'<font color="#5b2d8e"><b>{_pdf_esc(brand_name)}</b></font>'
    ] + [_pdf_esc(s) for s in subs[:2]]
    left_text = Paragraph('<br/>'.join(left_parts), styles['ReportHeaderLeft'])
    right = Paragraph(_pdf_esc(meta_raw), styles['ReportHeaderRight'])

    # Logo beside brand name (from HTML brand-logo img, else resources/PCODE_LOGO.png)
    logo_src = None
    logo_tag = re.search(r'<img\b[^>]*\bbrand-logo\b[^>]*>', section_html, re.IGNORECASE)
    if logo_tag:
        src_m = re.search(r'src=["\']([^"\']+)["\']', logo_tag.group(0), re.IGNORECASE)
        if src_m:
            logo_src = src_m.group(1).strip()
    if not logo_src:
        resources = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            'resources',
        )
        compact = os.path.join(resources, 'PCODE_LOGO_pdf.png')
        full = os.path.join(resources, 'PCODE_LOGO.png')
        logo_src = compact if os.path.exists(compact) else full
    logo = _load_image_flowable(logo_src, max_w=0.52 * inch, max_h=0.52 * inch)
    if logo is not None:
        brand_block = Table([[logo, left_text]], colWidths=[0.58 * inch, 3.72 * inch])
        brand_block.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('ALIGN', (0, 0), (0, 0), 'LEFT'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (0, 0), 6),
            ('RIGHTPADDING', (1, 0), (1, 0), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        left = brand_block
    else:
        left = left_text

    header = Table([[left, right]], colWidths=[4.4 * inch, 3.1 * inch])
    header.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ALIGN', (0, 0), (0, 0), 'LEFT'),
        ('ALIGN', (1, 0), (1, 0), 'RIGHT'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LINEBELOW', (0, 0), (-1, -1), 1.0, colors.black),
    ]))
    elements.append(header)
    elements.append(Spacer(1, 0.04 * inch))

    note = re.search(
        r'class=["\'][^"\']*\b(?:disclaimer|note)\b[^"\']*["\'][^>]*>(.*?)</p>',
        section_html,
        re.IGNORECASE | re.DOTALL,
    )
    if note:
        note_text = _strip_html_keep_breaks(note.group(1))
        if note_text:
            disclaimer_style = ParagraphStyle(
                'CoverDisclaimer',
                parent=styles['SectionBody'],
                fontSize=8.5,
                textColor=colors.HexColor('#333333'),
                alignment=TA_CENTER,
                fontName='Helvetica-Oblique',
                leading=11,
                spaceBefore=2,
                spaceAfter=2,
            )
            elements.append(Paragraph(_pdf_esc(note_text), disclaimer_style))
            # Rule below disclaimer (header already has LINEBELOW)
            rule = Table([['']], colWidths=[7.5 * inch])
            rule.setStyle(TableStyle([
                ('LINEBELOW', (0, 0), (-1, -1), 1.0, colors.black),
                ('TOPPADDING', (0, 0), (-1, -1), 2),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ]))
            elements.append(rule)
            elements.append(Spacer(1, 0.05 * inch))
    return elements


def process_section(section_html, styles):
    """Process a section and return ReportLab elements with bordered frames."""
    elements = []

    # Cover / system header (no section-title h2)
    if re.search(r'pcode-system-header|brand-name|data-section=["\']cover["\']', section_html, re.IGNORECASE) and \
       not re.search(r'class=["\']section-title["\']', section_html, re.IGNORECASE):
        return _process_cover_header(section_html, styles)

    title_match = re.search(
        r'<h2[^>]*class=["\'][^"\']*\bsection-title\b[^"\']*["\'][^>]*>(.*?)</h2>',
        section_html,
        re.IGNORECASE | re.DOTALL,
    )
    if title_match:
        title = _strip_html_keep_breaks(
            title_match.group(1).replace('🔍', '').replace('📋', '').replace('🧠', '')
        )
        # Never leave a literal &amp; visible in section headings
        title = title.replace('&amp;', '&')
        title = _fully_unescape(title)
        # Top/bottom rules only — no grey fill
        title_style = ParagraphStyle(
            'SectionTitleKeep',
            parent=styles['SectionTitle'],
            spaceBefore=0,
            spaceAfter=0,
            leading=12,
        )
        title_bar = Table(
            [[Paragraph(_pdf_esc(title), title_style)]],
            colWidths=[7.5 * inch],
        )
        title_bar.setStyle(TableStyle([
            ('LINEABOVE', (0, 0), (-1, -1), 1.0, colors.black),
            ('LINEBELOW', (0, 0), (-1, -1), 1.0, colors.black),
            ('BACKGROUND', (0, 0), (-1, -1), colors.white),
            ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ]))
        title_bar.keepWithNext = True
        elements.append(title_bar)
        elements.append(Spacer(1, 0.03 * inch))

    # Help / note paragraphs outside tables (avoid duplicating cell text)
    html_for_p = re.sub(r'<table\b[^>]*>.*?</table>', '', section_html, flags=re.DOTALL | re.IGNORECASE)
    p_pattern = r'<p([^>]*)>([^<]*(?:<[^>]*>[^<]*)*?)</p>'
    for p_match in re.finditer(p_pattern, html_for_p, re.IGNORECASE):
        p_attributes = p_match.group(1)
        p_content = p_match.group(2)
        text = _strip_html_keep_breaks(p_content)
        if not text:
            continue
        # Avoid duplicating short labels that belong to image captions inside tables
        if text.upper() in ('ULTRASOUND IMAGE', 'AI ATTENTION MAP (GRAD-CAM++)', 'INPUT ULTRASOUND', 'GRAD-CAM++ HEATMAP OVERLAY'):
            continue
        # Footer lines are drawn via onPage — skip in body flow
        cls = ''
        class_m = re.search(r'class\s*=\s*["\']([^"\']*)["\']', p_attributes, re.IGNORECASE)
        if class_m:
            cls = class_m.group(1).lower()
        if any(tok in cls for tok in ('computer', 'page-no', 'pcode-pdf-footer')):
            continue
        text = _pdf_esc(text)
        p_align = 'left'
        style_match = re.search(r'style\s*=\s*["\']([^"\']*)["\']', p_attributes, re.IGNORECASE)
        if style_match and 'text-align' in style_match.group(1).lower():
            align_match = re.search(r'text-align\s*:\s*(\w+)', style_match.group(1), re.IGNORECASE)
            if align_match:
                p_align = align_match.group(1).lower()
        if p_align == 'center':
            elements.append(Paragraph(text, styles['SectionBodyCenter']))
        else:
            elements.append(Paragraph(text, styles['SectionBody']))

    # Side-by-side ultrasound / Grad-CAM images (no content box grid)
    img_srcs = []
    for img_match in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*>', section_html, re.IGNORECASE):
        src = img_match.group(1).strip()
        flow = _load_image_flowable(src)
        if flow is not None:
            img_srcs.append(flow)
    if img_srcs:
        if len(img_srcs) == 1:
            frame = Table([[img_srcs[0]]], colWidths=[7.5 * inch])
        else:
            frame = Table([[img_srcs[0], img_srcs[1]]], colWidths=[3.75 * inch, 3.75 * inch])
        frame.setStyle(TableStyle([
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 3),
            ('RIGHTPADDING', (0, 0), (-1, -1), 3),
            ('TOPPADDING', (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
            ('BACKGROUND', (0, 0), (-1, -1), colors.white),
        ]))
        elements.append(Spacer(1, 0.03 * inch))
        elements.append(frame)
        elements.append(Spacer(1, 0.04 * inch))

    # Data tables — header/group rules only (no row/column grid)
    table_count = 0
    for table_match in re.finditer(r'<table[^>]*>(.*?)</table>', section_html, re.DOTALL | re.IGNORECASE):
        table_html = table_match.group(1)
        if re.search(r'<img\b', table_html, re.IGNORECASE):
            continue
        # Skip the system header branding table — already rendered above for cover
        if re.search(r'brand-name|pcode-system-header|clinic-meta', table_match.group(0), re.IGNORECASE):
            continue
        table_data = extract_table_data(table_html)
        if table_data:
            elements.append(_build_bordered_table(table_data, styles, table_count))
            elements.append(Spacer(1, 0.04 * inch))
            table_count += 1

    elements.append(Spacer(1, 0.03 * inch))
    return elements

def _extract_report_footer_lines(html_content):
    """Pull computer-generated + Report ID lines for the page footer."""
    computer = 'THIS IS A COMPUTER-GENERATED SCREENING REPORT.'
    meta = 'System: P-Code PMOS Decision Support'
    m_comp = re.search(
        r'class=["\'][^"\']*\bcomputer\b[^"\']*["\'][^>]*>(.*?)</p>',
        html_content,
        re.IGNORECASE | re.DOTALL,
    )
    if m_comp:
        t = _strip_html_keep_breaks(m_comp.group(1))
        if t:
            computer = t
    m_meta = re.search(
        r'class=["\'][^"\']*\bpage-no\b[^"\']*["\'][^>]*>(.*?)</p>',
        html_content,
        re.IGNORECASE | re.DOTALL,
    )
    if m_meta:
        t = _strip_html_keep_breaks(m_meta.group(1))
        if t:
            meta = re.sub(r'\s*\|\s*', '  |  ', t)
            meta = re.sub(r'\s+', ' ', meta).strip()
    return computer, meta


def generate_pdf(html_content, output_path):
    """Generate PDF preserving HTML structure and XAI sections"""
    try:
        # Extract sections from HTML
        sections = extract_sections(html_content)
        
        if not sections:
            raise Exception("No sections found in HTML")

        footer_computer, footer_meta = _extract_report_footer_lines(html_content)
        
        styles = getSampleStyleSheet()
        styles.add(ParagraphStyle(name='SectionTitle', parent=styles['Heading2'],
                                  fontSize=10, textColor=colors.black,
                                  spaceAfter=1, spaceBefore=1, fontName='Helvetica-Bold', leading=12))
        styles.add(ParagraphStyle(name='SectionBody', parent=styles['Normal'],
                                  fontSize=8.5, textColor=colors.HexColor('#222222'),
                                  spaceAfter=2, leading=10))
        styles.add(ParagraphStyle(name='SectionBodyCenter', parent=styles['Normal'],
                                  fontSize=8.5, textColor=colors.HexColor('#222222'),
                                  spaceAfter=2, leading=10, alignment=TA_CENTER))
        styles.add(ParagraphStyle(name='ReportHeaderLeft', parent=styles['Normal'],
                                  fontSize=9, textColor=colors.black,
                                  leading=11, alignment=TA_LEFT))
        styles.add(ParagraphStyle(name='ReportHeaderRight', parent=styles['Normal'],
                                  fontSize=8, textColor=colors.HexColor('#222222'),
                                  leading=10, alignment=TA_RIGHT))
        
        doc = SimpleDocTemplate(output_path, pagesize=A4,
                               rightMargin=12*mm, leftMargin=12*mm,
                               topMargin=10*mm, bottomMargin=18*mm)

        def _draw_footer(canvas, _doc):
            canvas.saveState()
            page_w, _page_h = A4
            canvas.setFillColor(colors.black)
            canvas.setFont('Helvetica-Bold', 8)
            canvas.drawCentredString(page_w / 2.0, 12 * mm, footer_computer)
            canvas.setFont('Helvetica', 7.5)
            canvas.drawCentredString(page_w / 2.0, 7.5 * mm, footer_meta)
            canvas.restoreState()
        
        story = []
        
        # Lab reports put branding inside sections — skip purple title banner
        # Process all sections
        for section in sections:
            story.extend(process_section(section, styles))
        
        # Build PDF with footer on every page
        doc.build(story, onFirstPage=_draw_footer, onLaterPages=_draw_footer)
        return True
        
    except Exception as e:
        raise Exception(f"PDF generation failed: {str(e)}")

def main():
    """Main entry point"""
    temp_file = None
    try:
        # Read from temp file (passed as argument)
        if len(sys.argv) > 1:
            temp_file = sys.argv[1]
            if not os.path.exists(temp_file):
                raise ValueError(f"Temp file not found: {temp_file}")
                
            with open(temp_file, 'r', encoding='utf-8-sig') as f:
                input_data = f.read()
            params = json.loads(input_data)
        else:
            # Fallback: read from stdin
            if sys.stdin.isatty():
                raise ValueError("No input provided")
            input_data = sys.stdin.read()
            if not input_data.strip():
                raise ValueError("No input data provided")
            if input_data.startswith('\ufeff'):
                input_data = input_data[1:]
            params = json.loads(input_data)
        
        html_content = params.get('html_content')
        output_path = params.get('output_path')
        
        if not html_content or not output_path:
            raise ValueError('Missing html_content or output_path')
        
        # Generate PDF
        generate_pdf(html_content, output_path)
        
        # Verify PDF was created
        if not os.path.exists(output_path):
            raise ValueError('PDF file was not created')
        
        # Success response
        print(json.dumps({
            'success': True,
            'message': 'PDF generated successfully',
            'output_path': output_path
        }))
    
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))
        sys.exit(1)
    
    finally:
        # Clean up temp file after all processing is complete
        if temp_file and os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except:
                pass

if __name__ == '__main__':
    main()
