#pragma once

#include <QPointer>
#include <QWidget>
#include <vector>

// Opt-in wrapper for fixed-resolution legacy skins. The live widget tree is
// resized in place; no controls, decks, or skin pages are recreated.
class WReferenceScaler : public QWidget {
  public:
    WReferenceScaler(QWidget* canvas, QSize referenceSize, QWidget* parent,
            bool fillWindow = false);
    QSize sizeHint() const override { return m_referenceSize; }
    double scale() const { return m_scale; }

  protected:
    void resizeEvent(QResizeEvent* event) override;
    bool event(QEvent* event) override;
    bool eventFilter(QObject* watched, QEvent* event) override;
    virtual bool startWindowMove();

  private:
    struct Metrics {
        QPointer<QWidget> widget;
        QSize minimum;
        QSize maximum;
        QFont font;
        QString style;
    };
    void applyScale();
    bool handleWindowDrag(QEvent* event);
    void finishWindowDrag();
    QWidget* m_canvas;
    QPointer<QWidget> m_skinContainer;
    QSize m_referenceSize;
    bool m_fillWindow;
    std::vector<Metrics> m_metrics;
    double m_scale = -1;
    bool m_pending = false;
    bool m_dragging = false;
    QPoint m_dragOffset;
};
