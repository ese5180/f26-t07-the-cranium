#pragma once


#include "wnumber.h"
#include <QTimer>
#include "preferences/dialog/dlgprefdeck.h"

class ControlProxy;

class WNumberPos : public WNumber {
    Q_OBJECT

  public:
    explicit WNumberPos(const QString& group, QWidget* parent = nullptr);
    void setup(const QDomNode& node, const SkinContext& context) override;

  protected:
    void mousePressEvent(QMouseEvent* pEvent) override;
    void mouseReleaseEvent(QMouseEvent* pEvent) override;

  private slots:
    void setValue(double dValue) override;
    void slotSetTimeElapsed(double);
    void slotTimeRemainingUpdated(double);
    void slotSetDisplayMode(double);
    void slotSetTimeFormat(double);

  private:

    QMetaObject::Connection m_rx3BeatsConnection;
    QMetaObject::Connection m_rx3CuesConnection;
    const QString m_group;
    TrackTime::DisplayMode m_displayMode;
    TrackTime::DisplayFormat m_displayFormat;

    double m_dOldTimeElapsed;
    ControlProxy* m_pTimeElapsed;
    ControlProxy* m_pTimeRemaining;
    ControlProxy* m_pShowTrackTimeRemaining;
    ControlProxy* m_pTimeFormat;
    ControlProxy* m_rx3TimeMode=nullptr;
    QTimer m_rx3Hold;
    bool m_rx3Pressed=false;bool m_rx3Held=false;
};
