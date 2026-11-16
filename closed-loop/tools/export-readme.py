#!/usr/bin/env python3
"""Export the current README as a readable checkoff PDF (status stays explicit).

Requires reportlab; the Codex bundled Python already includes it on this Mac.
"""
from pathlib import Path
import html
import re
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle,getSampleStyleSheet
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,Table,TableStyle,Preformatted

ROOT=Path(__file__).resolve().parents[1]


def inline(text):
    text=html.escape(text)
    text=re.sub(r'`([^`]+)`',r'<font name="Courier" size="8">\1</font>',text)
    text=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',text)
    text=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',r'<link color="#333333" href="\2"><u>\1</u></link>',text)
    return text


def main():
    dest=ROOT/'output/pdf/cranium-closed-loop-readme.pdf';dest.parent.mkdir(parents=True,exist_ok=True)
    styles=getSampleStyleSheet()
    styles.add(ParagraphStyle(name='Text',fontName='Helvetica',fontSize=9.3,leading=12.8,spaceAfter=5.5,
                              splitLongWords=True,allowWidows=0,allowOrphans=0))
    styles.add(ParagraphStyle(name='SmallCell',fontName='Helvetica',fontSize=8.7,leading=11.8,splitLongWords=True))
    styles['Title'].fontName='Helvetica-Bold';styles['Title'].fontSize=26;styles['Title'].leading=30;styles['Title'].alignment=TA_LEFT
    for name in ('Heading1','Heading2','Heading3'):
        styles[name].keepWithNext=True;styles[name].textColor=colors.black
    styles['Heading1'].fontSize=15;styles['Heading1'].leading=20
    styles['Heading2'].fontSize=12;styles['Heading2'].leading=16
    styles['Code'].fontSize=8;styles['Code'].leading=11
    story=[];lines=(ROOT/'README.md').read_text().splitlines();i=0
    while i<len(lines):
        line=lines[i]
        if not line.strip() or line.startswith('<!--') or line.startswith('[!['):i+=1;continue
        if line.startswith('```'):
            language=line[3:].strip();code=[];i+=1
            while i<len(lines) and not lines[i].startswith('```'):code.append(lines[i]);i+=1
            if language=='mermaid':
                code=['Requirement -> AI -> build/flash -> measurements -> verdict',
                      '                ^____________________________________|']
            story.append(Preformatted('\n'.join(code),styles['Code']));story.append(Spacer(1,6));i+=1;continue
        if line.startswith('|'):
            rows=[]
            while i<len(lines) and lines[i].startswith('|'):
                cells=[c.strip() for c in lines[i].strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?',c) for c in cells):
                    rows.append([Paragraph(inline(c),styles['SmallCell']) for c in cells])
                i+=1
            columns=len(rows[0])
            widths=[177,327] if columns==2 else [125,120,259] if columns==3 else [504/columns]*columns
            table=Table(rows,colWidths=widths,repeatRows=1,hAlign='LEFT')
            table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#eeeeee')),
                ('VALIGN',(0,0),(-1,-1),'TOP'),('BOX',(0,0),(-1,-1),.5,colors.HexColor('#bbbbbb')),
                ('INNERGRID',(0,0),(-1,-1),.3,colors.HexColor('#cccccc')),
                ('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),
                ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
            story += [table,Spacer(1,10)];continue
        if line.startswith('#'):
            level=len(line)-len(line.lstrip('#'));title=line[level:].strip()
            story.append(Paragraph(inline(title),styles['Title' if level==1 else 'Heading1' if level==2 else 'Heading2']))
            i+=1;continue
        bullet=re.match(r'^(?:- |\d+\. )(.*)',line)
        paragraph=[bullet.group(1) if bullet else line];i+=1
        while i<len(lines) and lines[i].strip() and not re.match(r'^(?:#|\||```|<!--|- |\d+\. )',lines[i]):
            paragraph.append(lines[i].strip());i+=1
        story.append(Paragraph(inline(' '.join(paragraph)),styles['Text'],bulletText='-' if bullet else None))
    def footer(canvas,doc):
        canvas.setStrokeColor(colors.HexColor('#cccccc'));canvas.line(54,42,558,42)
        canvas.setFont('Helvetica',8);canvas.setFillColor(colors.HexColor('#555555'))
        canvas.drawString(54,29,'CRANIUM | Closed-loop development | Current README export')
        canvas.drawRightString(558,29,str(doc.page))
    doc=SimpleDocTemplate(str(dest),pagesize=(612,792),leftMargin=54,rightMargin=54,topMargin=48,bottomMargin=56,
                          title='CRANIUM closed-loop workbench',author='CRANIUM project')
    doc.build(story,onFirstPage=footer,onLaterPages=footer)
    print(dest)


if __name__=='__main__':main()
