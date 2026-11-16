"""Render facts from a real experiment into the README's evidence section."""
from pathlib import Path

BEGIN='<!-- MEASUREMENTS:BEGIN -->'
END='<!-- MEASUREMENTS:END -->'


def update_readme(root, report, folder):
    path=Path(root)/'README.md'
    if not path.exists():return
    text=path.read_text()
    if BEGIN not in text or END not in text:return
    rows=[f'Latest run: **{report["status"].upper()}**. Physical HIL passed: **{report["hardware_passed"]}**.',
          f'Run ID: `{report["id"]}`.',f'Evidence: `{folder.relative_to(root)}/report.json`.']
    if report.get('power_comparison'):
        power=report['power_comparison']
        rows += ['', '| Metric | Measured result |','| --- | --- |',
                 f'| Baseline median | {power["baseline_median_uA"]:.2f} uA |',
                 f'| Optimized median | {power["optimized_median_uA"]:.2f} uA |',
                 f'| Reduction | {power["reduction_percent"]:.2f}% |',
                 f'| Every paired repeat improved | {power["every_pair_improved"]} |']
    if report.get('blocking'):rows+=['','Pending: '+'; '.join(report['blocking'])+'.']
    if report.get('error'):rows+=['','Failure: '+report['error']+'.']
    replacement='\n\n'+'\n\n'.join(rows[:3])+'\n'+'\n'.join(rows[3:])+'\n\n'
    before,rest=text.split(BEGIN,1);_,after=rest.split(END,1)
    result=before+BEGIN+replacement+END+after
    start,finish='<!-- STATUS:BEGIN -->','<!-- STATUS:END -->'
    if start in result and finish in result:
        left,rest=result.split(start,1);_,right=rest.split(finish,1)
        status=('**Latest physical peripheral and idle-power checks passed.** '
                if report['hardware_passed'] else '**Software ready; physical validation is '+report['status'].upper()+'.** ')
        status+='See Results and evidence below. A build or simulated capture is not a physical pass; the optional radio proof is recorded separately.'
        result=left+start+'\n\n'+status+'\n\n'+finish+right
    path.write_text(result)
