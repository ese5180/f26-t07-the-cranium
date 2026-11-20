#pragma once

#include <QColor>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <QStringList>

namespace rx3 {
inline QStringList sourceColorNames() {
    return {"DEFAULT","RED","ORANGE","YELLOW","GREEN","AQUA","BLUE","PURPLE"};
}
inline QColor sourceColor(int index) {
    const QStringList colors={"#30343b","#a83232","#ab6425","#8b7c20",
            "#34764a","#24777c","#285d9a","#754b91"};
    return QColor(colors.value(index,colors.first()));
}
// Nautic's portable accent is separate from rekordbox's proprietary files.
// Never create or modify a Pioneer DAT/PDB when choosing a display accent.
inline QString sourceAppearancePath(const QString& root) {
    return QDir(root).filePath("PIONEER/NAUTIC_BACKGROUND_COLOR.json");
}
inline int readSourceColor(const QString& root) {
    if(root.isEmpty()) return 0;
    QFile file(sourceAppearancePath(root));
    if(!file.open(QIODevice::ReadOnly) || file.size()>1024) return 0;
    const auto object=QJsonDocument::fromJson(file.readAll()).object();
    const auto value=object.value("color");
    const int index=value.toInt(-1);
    return object.value("version").toInt()==1 && value.isDouble() &&
            value.toDouble()==index && index>=0 && index<sourceColorNames().size()?index:0;
}
inline QString saveSourceColor(const QString& root,int color) {
    if(root.isEmpty() || !QDir(root).exists() || !QDir(QDir(root).filePath("PIONEER")).exists())
        return "Select a connected rekordbox USB in SOURCE first.";
    if(color<0 || color>=sourceColorNames().size()) return "Unsupported background color.";
    QSaveFile file(sourceAppearancePath(root));
    const auto bytes=QJsonDocument(QJsonObject{{"version",1},{"color",color}}).toJson(QJsonDocument::Compact);
    if(!file.open(QIODevice::WriteOnly) || file.write(bytes)!=bytes.size() || !file.commit())
        return "Unable to save background color to this USB. Check write access.";
    return {};
}
} // namespace rx3
