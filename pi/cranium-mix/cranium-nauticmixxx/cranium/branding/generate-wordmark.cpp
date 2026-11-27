// CRANIUM wordmark: outlined Open Sans glyphs, no runtime font dependency.
// Font attribution/license: sibling engine res/fonts/OpenSans.LICENSE.txt.
#include <QApplication>
#include <QFileInfo>
#include <QFontDatabase>
#include <QPainter>
#include <QPainterPath>
#include <QSvgGenerator>
#include <QTransform>
int main(int argc,char** argv) {
    QApplication app(argc,argv);
    if(argc!=3) return 2;
    const int id=QFontDatabase::addApplicationFont(QString::fromLocal8Bit(argv[1]));
    if(id<0) return 3;
    QFont font(QFontDatabase::applicationFontFamilies(id).first());
    font.setPixelSize(80);font.setWeight(QFont::Normal);
    font.setLetterSpacing(QFont::AbsoluteSpacing,12);
    QPainterPath glyphs;glyphs.addText(0,0,font,QStringLiteral("CRANIUM"));
    const QRectF bounds=glyphs.boundingRect();
    const double scale=470.0/bounds.width();
    QTransform fit;fit.translate(300,100);fit.scale(scale,scale);fit.translate(-bounds.center().x(),-bounds.center().y());
    QSvgGenerator svg;svg.setFileName(QString::fromLocal8Bit(argv[2]));
    svg.setSize(QSize(600,200));svg.setViewBox(QRect(0,0,600,200));
    svg.setTitle("CRANIUM");svg.setDescription("White CRANIUM wordmark. Outlined Open Sans Regular, spaced uppercase lettering.");
    QPainter painter(&svg);painter.setRenderHint(QPainter::Antialiasing);
    painter.setPen(Qt::NoPen);painter.setBrush(Qt::white);painter.drawPath(fit.map(glyphs));painter.end();
    return QFileInfo::exists(QString::fromLocal8Bit(argv[2]))?0:4;
}
