#pragma once

#include <QPainter>
#include <QPolygonF>
#include <QPainterPath>
#include <QMouseEvent>
#include <QHideEvent>
#include <QMenu>
#include <memory>
#include "control/controlobject.h"
#include "widget/wlabel.h"
#include "widget/wpushbutton.h"
#include "widget/wwidgetgroup.h"

// Paint the complete range label so number and percent receive exactly the
// same one-pixel stroke. WIDE has no suffix or colored rectangle.
class WRx3RangeBadge : public WWidgetGroup {
  public:
    WRx3RangeBadge(const QString& group, QWidget* parent = nullptr)
            : WWidgetGroup(parent) {
        auto* range = new ControlProxy(group, "rateRange", this, ControlFlag::NoAssertIfMissing);
        auto refresh = [this](double value) {
            m_range = value;
            setHighlight(qAbs(value-0.06)<1e-6 ? 1 : qAbs(value-0.16)<1e-6 ? 2 : value>=1.0 ? 3 : 0);
            update();
        };
        range->connectValueChanged(this, refresh);
        refresh(range->get());
    }
  protected:
    void paintEvent(QPaintEvent* event) override {
        WWidgetGroup::paintEvent(event);
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        const bool wide = m_range>=1.0;
        const QString text = wide ? QStringLiteral("WIDE") : QString::number(qRound(m_range*100))+"%";
        QFont labelFont=font();labelFont.setPixelSize(qMax(9,qRound(height()*0.65)));
        labelFont.setWeight(QFont::Light);
        const QFontMetricsF metrics(labelFont);
        QPainterPath path;
        path.addText(QPointF((width()-metrics.horizontalAdvance(text))/2,
                (height()-metrics.height())/2+metrics.ascent()),labelFont,text);
        const QColor color(wide ? "#BF3413" : "#000000");
        painter.setPen(QPen(color,1));painter.setBrush(color);painter.drawPath(path);
    }
  private:
    double m_range=0.06;
};

class WRx3QuantizeValue : public WLabel {
  public:
    using WLabel::WLabel;
    void setup(const QDomNode& node,const SkinContext& context) override {
        WLabel::setup(node,context);
        const auto group=QString("[Channel%1]").arg(context.selectString(node,"Channel"));
        auto* value=new ControlProxy(group,"rx3_quantize_beats",this,ControlFlag::NoAssertIfMissing);
        auto refresh=[this](double beats){setText(beats>=1?"1":beats>=0.5?"1/2":beats>=0.25?"1/4":"1/8");};
        value->connectValueChanged(this,refresh);refresh(value->get());
    }
};

class WRx3ModeTitle : public WLabel {
  public:
    using WLabel::WLabel;
  protected:
    void paintEvent(QPaintEvent* event) override {
        WLabel::paintEvent(event);
        QPainter painter(this);
        painter.setPen(QColor("#272727"));
        const qreal gap=fontMetrics().horizontalAdvance(text())/2.0+12;
        const qreal middle=width()/2.0;
        painter.drawLine(QPointF(0,height()/2.0),QPointF(middle-gap,height()/2.0));
        painter.drawLine(QPointF(middle+gap,height()/2.0),QPointF(width(),height()/2.0));
    }
};

class WRx3JumpPad : public WPushButton {
  public:
    using WPushButton::WPushButton;
    void setup(const QDomNode& node,const SkinContext& context) override {
        m_reverse=context.selectBool(node,"Reverse",false);
        WPushButton::setup(node,context);
        for(auto& label:m_text) if(label=="0.5") label="1/2";
    }
  protected:
    void paintEvent(QPaintEvent* event) override {
        WPushButton::paintEvent(event);
        QPainter painter(this);painter.setRenderHint(QPainter::Antialiasing);
        painter.setPen(QPen(QColor("#999999"),1));painter.setBrush(Qt::NoBrush);
        painter.drawRect(QRectF(rect()).adjusted(0.5,0.5,-0.5,-0.5));
        if(m_reverse) {painter.translate(width(),0);painter.scale(-1,1);}
        const qreal h=qMin(10.0,height()*0.6);
        painter.setPen(Qt::NoPen);painter.setBrush(QColor("#999999"));
        painter.drawPolygon(QPolygonF{QPointF(0,0),QPointF(24,0),QPointF(18,h),QPointF(0,h)});
        painter.setBrush(QColor("#252525"));
        for(int i=0;i<2;++i) {
            const qreal x=5+i*7;
            painter.drawPolygon(QPolygonF{QPointF(x,2),QPointF(x+4,5),QPointF(x,8)});
        }
    }
  private:
    bool m_reverse=false;
};

class WRx3GridButton : public WPushButton {
  public:
    using WPushButton::WPushButton;
  protected:
    void mousePressEvent(QMouseEvent* event) override {
        if(event->button()==Qt::LeftButton) {
            const ConfigKey key("[RX3Controller]","grid_mode");
            ControlObject::set(key,ControlObject::get(key)>0?0:1);
            event->accept();
        } else WPushButton::mousePressEvent(event);
    }
    void mouseReleaseEvent(QMouseEvent* event) override {
        if(event->button()==Qt::LeftButton) {event->accept();update();}
        else WPushButton::mouseReleaseEvent(event);
    }
};

// Momentary touch pads share the same engine action as controller SLIP LOOP.
class WRx3SlipLoopPad : public WPushButton {
  public:
    using WPushButton::WPushButton;
    void setup(const QDomNode& node, const SkinContext& context) override {
        WPushButton::setup(node, context);
        const QString group = QString("[Channel%1]").arg(context.selectString(node, "Channel"));
        m_loop = std::make_unique<ControlProxy>(group, "rx3_slip_loop", this);
        const QStringList fraction = context.selectString(node, "Beats").split('/');
        const double numerator = fraction.value(0).toDouble();
        const double denominator = fraction.size() > 1 ? fraction.value(1).toDouble() : 1;
        m_beats = denominator > 0 ? numerator / denominator : 0;
    }
  protected:
    void mousePressEvent(QMouseEvent* event) override {
        if (event->button() == Qt::LeftButton && m_loop && m_beats > 0) {
            m_held = true;
            m_loop->set(m_beats);
            event->accept();
        } else {
            WPushButton::mousePressEvent(event);
        }
    }
    void mouseReleaseEvent(QMouseEvent* event) override {
        if (event->button() == Qt::LeftButton && m_held) {
            releaseLoop();
            event->accept();
        } else {
            WPushButton::mouseReleaseEvent(event);
        }
    }
    void hideEvent(QHideEvent* event) override {
        releaseLoop();
        WPushButton::hideEvent(event);
    }
  private:
    void releaseLoop() {
        if (m_held && m_loop) m_loop->set(0);
        m_held = false;
    }
    std::unique_ptr<ControlProxy> m_loop;
    double m_beats = 0;
    bool m_held = false;
};

// Native toggle/feedback for both RX3 Beat Loop tables.
class WRx3BeatLoopPad : public WPushButton {
  public:
    using WPushButton::WPushButton;
    void setup(const QDomNode& node, const SkinContext& context) override {
        WPushButton::setup(node, context);
        const QString group = QString("[Channel%1]").arg(context.selectString(node, "Channel"));
        const auto fraction = context.selectString(node, "Beats").split('/');
        const double denominator = fraction.size() > 1 ? fraction[1].toDouble() : 1;
        const double beats = denominator > 0 ? fraction[0].toDouble() / denominator : 0;
        if (beats <= 0) return;
        m_toggle = std::make_unique<ControlProxy>(group, QString("beatloop_%1_toggle").arg(beats), this);
        m_enabled = std::make_unique<ControlProxy>(group, QString("beatloop_%1_enabled").arg(beats), this);
        m_enabled->connectValueChanged(this, [this](double) { update(); });
    }
  protected:
    void paintEvent(QPaintEvent* event) override {
        WPushButton::paintEvent(event);
        if (m_enabled && m_enabled->get() > 0) {
            QPainter painter(this); painter.setPen(Qt::white);
            painter.drawRect(rect().adjusted(0, 0, -1, -1));
        }
    }
    void mousePressEvent(QMouseEvent* event) override {
        if (event->button() == Qt::LeftButton && m_toggle) {
            m_toggle->set(1); m_toggle->set(0); event->accept();
        } else WPushButton::mousePressEvent(event);
    }
    void mouseReleaseEvent(QMouseEvent* event) override {
        if (event->button() == Qt::LeftButton) event->accept();
        else WPushButton::mouseReleaseEvent(event);
    }
  private:
    std::unique_ptr<ControlProxy> m_toggle, m_enabled;
};

class WRx3ReleaseFxPad : public WPushButton {
  public:
    using WPushButton::WPushButton;
    void setup(const QDomNode& node, const SkinContext& context) override {
        WPushButton::setup(node, context);
        const auto group = QString("[Channel%1]").arg(context.selectString(node, "Channel"));
        m_pad = context.selectInt(node, "Pad");
        m_hold = std::make_unique<ControlProxy>(group, QString("rx3_release_fx_%1").arg(m_pad), this);
        m_latch = std::make_unique<ControlProxy>(group, QString("rx3_release_fx_%1_latch").arg(m_pad), this);
        m_status = std::make_unique<ControlProxy>(group, "rx3_release_fx_active", this);
        m_status->connectValueChanged(this, [this](double) { update(); });
    }
  protected:
    void paintEvent(QPaintEvent* event) override {
        WPushButton::paintEvent(event);
        if (m_status && qRound(m_status->get()) == m_pad) {
            QPainter painter(this); painter.setPen(Qt::white); painter.drawRect(rect().adjusted(0, 0, -1, -1));
        }
    }
    void mousePressEvent(QMouseEvent* event) override {
        if (event->button() != Qt::LeftButton) { WPushButton::mousePressEvent(event); return; }
        if (event->modifiers().testFlag(Qt::ShiftModifier)) { m_latch->set(1); m_latch->set(0); }
        else { m_held = true; m_hold->set(1); }
        event->accept();
    }
    void mouseReleaseEvent(QMouseEvent* event) override {
        if (event->button() == Qt::LeftButton) { release(); event->accept(); }
        else WPushButton::mouseReleaseEvent(event);
    }
    void hideEvent(QHideEvent* event) override { release(); WPushButton::hideEvent(event); }
  private:
    void release() { if (m_held) { m_hold->set(0); m_held = false; } }
    int m_pad = 0; bool m_held = false;
    std::unique_ptr<ControlProxy> m_hold, m_latch, m_status;
};

class WRx3MemoryButton : public WPushButton {
  public:
    explicit WRx3MemoryButton(QWidget* parent) : WPushButton(parent) {}
    void setup(const QDomNode& node, const SkinContext& context) override {
        WPushButton::setup(node, context);
        m_group = QString("[Channel%1]").arg(context.selectString(node, "Channel"));
    }
  protected:
    void mousePressEvent(QMouseEvent* event) override {
        if (event->button() != Qt::LeftButton) return;
        QMenu menu(this);
        const auto count = ControlObject::get(ConfigKey(m_group, "rx3_memory_count"));
        menu.addSection(QString("MEMORY CUES (%1/10)").arg(int(count)));
        const QStringList keys{"prev", "next", "store", "delete", "active"};
        const QStringList labels{"CUE/LOOP CALL Previous", "CUE/LOOP CALL Next", "MEMORY", "DELETE", "Active Loop On/Off"};
        for (int i = 0; i < keys.size(); ++i) {
            auto* action = menu.addAction(labels[i]);
            connect(action, &QAction::triggered, &menu, [this, key=keys[i]] {
                ControlObject::set(ConfigKey(m_group, "rx3_memory_" + key), 1);
                ControlObject::set(ConfigKey(m_group, "rx3_memory_" + key), 0);
            });
        }
        menu.exec(mapToGlobal(rect().bottomLeft())); event->accept();
    }
  private:
    QString m_group;
};
