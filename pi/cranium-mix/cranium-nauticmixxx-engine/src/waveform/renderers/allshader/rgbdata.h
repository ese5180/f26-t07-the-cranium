#pragma once

#include <QVector3D>
#include <QColor>
#include <QVector>

namespace allshader {
class RGBData;
}

class allshader::RGBData {
    QVector<QVector3D> mData;

  public:
    void addForRectangle(float r, float g, float b) {
        mData.push_back({r, g, b});
        mData.push_back({r, g, b});
        mData.push_back({r, g, b});
        mData.push_back({r, g, b});
        mData.push_back({r, g, b});
        mData.push_back({r, g, b});
    }
    void addGradientRectangle(QRgb top, QRgb bottom) {
        const QVector3D t(qRed(top)/255.f,qGreen(top)/255.f,qBlue(top)/255.f);
        const QVector3D b(qRed(bottom)/255.f,qGreen(bottom)/255.f,qBlue(bottom)/255.f);
        mData << t << t << b << b << b << t;
    }
    void clear() {
        mData.clear();
    }
    void reserve(int size) {
        mData.reserve(size);
    }
    int size() const {
        return mData.size();
    }
    const QVector3D* constData() const {
        return mData.constData();
    }
};
