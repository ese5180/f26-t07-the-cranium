#pragma once

#include <QHideEvent>
#include <QFontInfo>
#include <QHBoxLayout>
#include <QLabel>
#include <QMouseEvent>
#include <QMenu>
#include <QPainter>
#include <QPointer>
#include <QPushButton>
#include <QSignalBlocker>
#include <QSlider>
#include <QStyle>
#include <QTouchEvent>
#include <QTimer>
#include <memory>
#include <limits>
#include <QVBoxLayout>
#include <array>
#include <cmath>
#include <functional>

#include "control/controlproxy.h"
#include "effects/effectchain.h"
#include "effects/effectknobparameterslot.h"
#include "effects/effectparameter.h"
#include "effects/effectslot.h"
#include "effects/effectsmanager.h"
#include "effects/visibleeffectslist.h"
#include "widget/wlabel.h"
#include "widget/rx3displayformat.h"
#include "widget/rx3beatfxeffects.h"

// Absolute horizontal position, including touch input, rather than QSlider's
// page-step clicks. The engine retains responsibility for effect quantization.
class WRx3XPad : public QSlider {
  public:
    enum class Layout { Empty, Continuous, Beats, Pitch };
    struct Cell { QString label; double target; bool enabled; };
    Layout presentation() const { return m_layout; }
    const QList<Cell>& cells() const { return m_cells; }
    std::function<void(double)> activateCell;
    void present(Layout layout, const QList<Cell>& cells, double current) {
        m_layout = layout;
        m_cells = cells;
        m_currentCell = -1;
        for (int index = 0; index < cells.size(); ++index)
            if (cells[index].enabled && std::abs(cells[index].target - current) < 0.00001)
                m_currentCell = index;
        update();
    }
    explicit WRx3XPad(QWidget* parent) : QSlider(Qt::Horizontal, parent) {
        setObjectName("RX3XPadSlider");
        setAttribute(Qt::WA_AcceptTouchEvents);
        setRange(0, 1000);
        setAccessibleName("X-PAD");
        connect(this, &QSlider::sliderPressed, this, [this] { update(); });
        connect(this, &QSlider::sliderReleased, this, [this] { update(); });
    }
  protected:
    void paintEvent(QPaintEvent*) override {
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        const bool pressed = isEnabled() && isSliderDown() && m_layout == Layout::Continuous;
        const QColor accent = pressed ? QColor("#00afff") : QColor("#a0a0a0");
        const double scale = height() / 40.0;
        const double center = height() / 2.0;
        const double left = 12 * scale;
        const double right = width() - left;
        painter.fillRect(rect(), QColor("#202020"));
        painter.setPen(QPen(QColor(pressed ? "#0088c4" : "#626262"), 1));
        painter.setBrush(Qt::NoBrush);
        painter.drawRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5));
        if (m_layout == Layout::Beats || m_layout == Layout::Pitch) {
            const double cellWidth = width() / double(qMax(1, m_cells.size()));
            auto face = font(); face.setPixelSize(qRound(16 * scale)); face.setBold(true);
            painter.setFont(face);
            for (int index = 0; index < m_cells.size(); ++index) {
                const QRectF cell(index * cellWidth, 0.5, cellWidth, height() - 1);
                const bool selected = index == m_currentCell && m_cells[index].enabled;
                if (selected) painter.fillRect(cell, QColor("#777b78"));
                painter.setPen(QPen(QColor("#929292"), 1));
                if (index > 0) painter.drawLine(cell.topLeft(), cell.bottomLeft());
                painter.setPen(QColor(m_cells[index].enabled ? "#eeeeee" : "#666666"));
                painter.drawText(cell, Qt::AlignCenter, m_cells[index].label);
            }
            if (m_currentCell >= 0 && m_cells[m_currentCell].enabled) {
                // Paint after the dividers so the selected cell keeps a
                // complete one-pixel white outline, including on release.
                painter.setRenderHint(QPainter::Antialiasing, false);
                painter.setPen(QPen(Qt::white, 1));
                painter.setBrush(Qt::NoBrush);
                painter.drawRect(QRectF(m_currentCell * cellWidth + 1.5,
                        1.5, cellWidth - 3, height() - 3));
            }
            return;
        }
        if (right - left < 30 * scale) return;
        QLinearGradient railColor(left, 0, right, 0);
        railColor.setColorAt(0, accent);
        railColor.setColorAt(0.12, accent);
        railColor.setColorAt(0.5, QColor("#65696b"));
        railColor.setColorAt(0.88, accent);
        railColor.setColorAt(1, accent);
        if (pressed) {
            QLinearGradient glow(left, 0, right, 0);
            glow.setColorAt(0, QColor(0, 175, 255, 45));
            glow.setColorAt(0.5, QColor(0, 175, 255, 0));
            glow.setColorAt(1, QColor(0, 175, 255, 45));
            painter.fillRect(QRectF(left, center - 9 * scale,
                    right - left, 18 * scale), glow);
        }
        // RX3's long tapered rail and open end arrows, with no slider thumb.
        const double inset = 13 * scale;
        const double tip = 7 * scale;
        QPolygonF rail;
        rail << QPointF(left + inset, center - 4.5 * scale)
             << QPointF(right - inset, center - 4.5 * scale)
             << QPointF(right - tip, center)
             << QPointF(right - inset, center + 4.5 * scale)
             << QPointF(left + inset, center + 4.5 * scale)
             << QPointF(left + tip, center);
        painter.setPen(Qt::NoPen);
        painter.setBrush(railColor);
        painter.drawPolygon(rail);
        painter.setPen(QPen(accent, 2 * scale, Qt::SolidLine, Qt::SquareCap, Qt::MiterJoin));
        painter.setBrush(Qt::NoBrush);
        QPolygonF arrow;
        arrow << QPointF(left + 5 * scale, center - 4 * scale)
              << QPointF(left, center)
              << QPointF(left + 5 * scale, center + 4 * scale);
        painter.drawPolyline(arrow);
        arrow.clear();
        arrow << QPointF(right - 5 * scale, center - 4 * scale)
              << QPointF(right, center)
              << QPointF(right - 5 * scale, center + 4 * scale);
        painter.drawPolyline(arrow);
    }
    void mousePressEvent(QMouseEvent* event) override {
        if (event->button() != Qt::LeftButton) { event->ignore(); return; }
        if (!position(event->position().x())) { event->ignore(); return; }
        setSliderDown(true);
        event->accept();
    }
    void mouseMoveEvent(QMouseEvent* event) override {
        if (!isSliderDown()) { event->ignore(); return; }
        position(event->position().x());
        event->accept();
    }
    void mouseReleaseEvent(QMouseEvent* event) override {
        if (event->button() != Qt::LeftButton) { event->ignore(); return; }
        setSliderDown(false);
        event->accept();
    }
    void hideEvent(QHideEvent* event) override {
        setSliderDown(false);
        QSlider::hideEvent(event);
    }
    bool event(QEvent* event) override {
        if (event->type() == QEvent::TouchBegin || event->type() == QEvent::TouchUpdate) {
            auto* touch = static_cast<QTouchEvent*>(event);
            const bool valid = !touch->points().isEmpty() &&
                    position(touch->points().first().position().x());
            if (valid) setSliderDown(true);
            event->accept();
            return true;
        }
        if (event->type() == QEvent::TouchEnd || event->type() == QEvent::TouchCancel ||
                event->type() == QEvent::UngrabMouse) {
            setSliderDown(false);
            if (event->type() != QEvent::UngrabMouse) { event->accept(); return true; }
        }
        return QSlider::event(event);
    }
  private:
    bool position(double x) {
        if (!isEnabled() || m_layout == Layout::Empty) return false;
        if (m_layout != Layout::Continuous) {
            if (m_cells.isEmpty()) return false;
            const int index = qBound(0, int(x * m_cells.size() / qMax(1, width())), int(m_cells.size()) - 1);
            if (!m_cells[index].enabled) return false;
            if (activateCell) activateCell(m_cells[index].target);
        } else {
            setValue(qRound(qBound(0.0, x / qMax(1, width() - 1), 1.0) * maximum()));
        }
        return true;
    }
    Layout m_layout = Layout::Empty;
    QList<Cell> m_cells;
    int m_currentCell = -1;
};

class WRx3BankButton : public QPushButton {
  public:
    std::function<void()> edit;
    explicit WRx3BankButton(QWidget* parent) : QPushButton(parent) {
        m_hold.setSingleShot(true);
        connect(&m_hold, &QTimer::timeout, this, [this] {
            if (!isDown()) return;
            m_consumed = true;
            setDown(false);
            if (edit) edit();
        });
    }
  protected:
    void mousePressEvent(QMouseEvent* event) override {
        m_consumed = false;
        QPushButton::mousePressEvent(event);
        if (event->button() == Qt::LeftButton) m_hold.start(650);
    }
    void mouseReleaseEvent(QMouseEvent* event) override {
        m_hold.stop();
        if (m_consumed) {m_consumed = false; setDown(false); event->accept(); return;}
        QPushButton::mouseReleaseEvent(event);
    }
    void hideEvent(QHideEvent* event) override {m_hold.stop(); setDown(false); QPushButton::hideEvent(event);}
  private:
    QTimer m_hold;
    bool m_consumed = false;
};

class WRx3BeatFx : public QWidget {
  public:
    WRx3BeatFx(UserSettingsPointer config, EffectsManager* effects, QWidget* parent)
            : QWidget(parent), m_config(config), m_effects(effects) {
        setObjectName("RX3BeatFxControls");
        auto* row = new QHBoxLayout(this);
        row->setContentsMargins(0, 0, 0, 0);
        row->setSpacing(12);
        auto* bank = new QVBoxLayout;
        bank->setSpacing(2);
        bank->addWidget(caption("BEAT FX SELECT"));
        auto* bankRow = new QHBoxLayout;
        bankRow->setSpacing(8);
        bank->addLayout(bankRow);
        for (int index = 0; index < 4; ++index) {
            m_ids[index] = m_config->getValueString(bankKey(index));
            auto* button = new WRx3BankButton(this);
            button->edit = [this, index] { chooseEffect(index); };
            button->setObjectName(QString("RX3BankSlot%1").arg(index + 1));
            button->setProperty("rx3Bank", true);
            button->setMinimumWidth(0);
            button->setFixedHeight(40);
            bankRow->addWidget(button, 1);
            m_buttons[index] = button;
            connect(button, &QPushButton::clicked, this, [this, index] { useBank(index); });
        }
        m_delete = new QPushButton(QString::fromUtf8("⌫"), this);
        m_delete->setObjectName("RX3BankDelete");
        m_delete->setCheckable(true);
        m_delete->setFixedSize(36, 40);
        m_delete->setToolTip("Delete a bank registration: touch this button, then its slot.");
        connect(m_delete, &QPushButton::toggled, this, [this] { refresh(); });
        bankRow->addWidget(m_delete);
        row->addLayout(bank, 1);
        auto* pad = new QVBoxLayout;
        pad->setSpacing(2);
        pad->addWidget(caption("X-PAD"));
        m_pad = new WRx3XPad(this);
        m_pad->setFixedHeight(40);
        m_pad->activateCell = [this](double value) {
            if (!m_slot || !m_parameter) return;
            // A zero Pitch Shift range cannot transpose. Initialize one octave
            // only on touch, keeping effect selection/view changes passive.
            if (m_slot->id().endsWith(".pitchshift")) {
                const auto range = parameterForId(m_slot, "range");
                if (range && range->getValue() <= 0)
                    for (unsigned int index = 0; index < m_slot->numParameters(EffectParameterType::Knob); ++index) {
                        const auto knob = m_slot->getEffectParameterSlot(EffectParameterType::Knob, index);
                        if (knob->getManifest() && knob->getManifest()->id() == "range")
                            ControlObject::set(ConfigKey(m_slot->getGroup(),
                                    EffectKnobParameterSlot::formatItemPrefix(knob->slotNumber())), 1);
                    }
            }
            rx3SetFxParameter(m_slot, "rx3_exact_time", 1);
            // Discrete cells specify real processor values, not slider positions.
            ControlObject::set(ConfigKey(m_slot->getGroup(),
                    EffectKnobParameterSlot::formatItemPrefix(m_parameter->slotNumber())), value);
        };
        pad->addWidget(m_pad);
        row->addLayout(pad, 1);
        connect(m_pad, &QSlider::valueChanged, this, [this](int value) { changeParameter(value); });
        connect(m_pad, &QSlider::sliderPressed, this, [this] {
            if (!m_slot || !m_slot->isLoaded()) return;
            m_touching = true;
            if(ControlObject::exists(ConfigKey("[RX3BeatFx]","xpad_hold"))) ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_hold"),1);
            rx3SetBeatFxEnabled(m_slot, true);
            ControlObject::set(ConfigKey(unitGroup(), "enabled"), 1);
        });
        connect(m_pad, &QSlider::sliderReleased, this, [this] { releasePad(); });
        if (m_effects) {
            const auto chain = m_effects->getEffectChain(unitGroup());
            if (chain) m_slot = chain->getEffectSlot(0);
        }
        if (m_slot) {
            connect(m_slot.data(), &EffectSlot::effectChanged, this, [this] { bindParameter(); });
            connect(m_slot.data(), &EffectSlot::parametersChanged, this, [this] { bindParameter(); });
        }
        auto* enabled = new ControlProxy(unitGroup(), "enabled", this, ControlFlag::NoAssertIfMissing);
        enabled->connectValueChanged(this, [this] { refresh(); });
        auto* bpm = new ControlProxy("[RX3Display]", "master_bpm", this, ControlFlag::NoAssertIfMissing);
        bpm->connectValueChanged(this, [this] { refresh(); });
        auto* effectEnabled = new ControlProxy("[EffectRack1_EffectUnit1_Effect1]", "enabled", this,
                ControlFlag::NoAssertIfMissing);
        effectEnabled->connectValueChanged(this, [this] { refresh(); });
        auto* meta = new ControlProxy("[EffectRack1_EffectUnit1_Effect1]", "meta", this,
                ControlFlag::NoAssertIfMissing);
        meta->connectValueChanged(this, [this] { refresh(); });
        ensureControl("bpm", 0, [](double){});
        ensureControl("amount", m_config->getValue(ConfigKey("[RX3BeatFx]", "amount"), 0.5), [this](double value) {setAmount(value);});
        ensureControl("select", 0, [this](double value) {
            if (!m_effects) return;
            const auto list = rx3BeatFxManifests(m_effects->getBackendManager());
            const int index = qRound(value) - 1;
            if (index >= 0 && index < list.size()) selectEffect(list[index], false);
        });
        ensureControl("select_next", 0, [this](double value) {if (value > 0) cycleEffect(1);});
        ensureControl("select_previous", 0, [this](double value) {if (value > 0) cycleEffect(-1);});
        ensureControl("toggle", 0, [this](double value) {
            if (value > 0 && m_slot)
                setActive(!(ControlObject::get(ConfigKey(unitGroup(), "enabled")) > 0 &&
                        ControlObject::get(ConfigKey(m_slot->getGroup(), "enabled")) > 0));
        });
        ensureControl("step", 0, [this](double value) {if (value != 0) stepPad(value > 0 ? 1 : -1);});
        ensureControl("bank_recall", 0, [this](double value) {if (value >= 1 && value <= 4) useBank(qRound(value) - 1);});
        ensureControl("bank_store", 0, [this](double value) {if (value >= 1 && value <= 4 && m_slot && m_slot->isLoaded()) registerBank(qRound(value) - 1, m_slot->getManifest());});
        ensureControl("bank_clear", 0, [this](double value) {if (value >= 1 && value <= 4) clearBank(qRound(value) - 1);});
        ensureControl("xpad_position", 0.5, [this](double value) {positionPad(value);});
        ensureControl("xpad_hold", 0, [this](double value) {
            m_pad->setSliderDown(value > 0 && m_slot && m_slot->isLoaded() && m_pad->isEnabled());
        });
        for(const auto& key:QList<ConfigKey>{ConfigKey("[RX3BeatFx]","bpm_mode"),ConfigKey("[RX3BeatFx]","bpm_manual"),ConfigKey("[Channel1]","visual_bpm"),ConfigKey("[Channel2]","visual_bpm"),ConfigKey(unitGroup(),"group_[Master]_enable"),ConfigKey(unitGroup(),"group_[Channel1]_enable"),ConfigKey(unitGroup(),"group_[Channel2]_enable")}) {
            auto* proxy=new ControlProxy(key.group,key.item,this,ControlFlag::NoAssertIfMissing);
            proxy->connectValueChanged(this,[this]{refresh();});
        }
        if(m_slot && m_slot->isLoaded() && m_config->getValue(ConfigKey("[RX3BeatFx]","controls_version"),0)<1 &&
                ControlObject::get(ConfigKey(unitGroup(),"enabled"))<=0)
            rx3PrepareBeatFx(m_slot,m_slot->getManifest());
        m_config->setValue(ConfigKey("[RX3BeatFx]","controls_version"),1);
        setAmount(amount());
        bindParameter();
    }
    ~WRx3BeatFx() override {
        m_pad->setSliderDown(false);
        releasePad();
    }
    static QString unitGroup() { return QStringLiteral("[EffectRack1_EffectUnit1]"); }
    static EffectParameterPointer parameterForId(const EffectSlotPointer& slot, const QString& id) {
        if (!slot) return {};
        for (const auto& map : {slot->getLoadedParameters(), slot->getHiddenParameters()})
            for (auto list = map.cbegin(); list != map.cend(); ++list)
                for (const auto& parameter : list.value())
                    if (parameter->manifest()->id() == id) return parameter;
        return {};
    }
    void selectEffect(const EffectManifestPointer& manifest, bool activate) {
        if (!m_slot || !isRx3BeatFx(manifest)) return;
        m_pad->setSliderDown(false);
        if (!m_slot->getManifest() || m_slot->getManifest()->uniqueId() != manifest->uniqueId())
            rx3LoadBeatFx(m_slot, manifest);
        if (activate) {rx3SetBeatFxEnabled(m_slot, true); ControlObject::set(ConfigKey(unitGroup(), "enabled"), 1);}
        refresh();
    }
    void cycleEffect(int direction) {
        if (!m_effects || !m_slot || direction == 0) return;
        const auto manifests = rx3BeatFxManifests(m_effects->getBackendManager());
        if (manifests.isEmpty()) return;
        int current = -1;
        for (int index = 0; index < manifests.size(); ++index)
            if (m_slot->getManifest() && manifests[index]->uniqueId() == m_slot->getManifest()->uniqueId()) {
                current = index; break;
            }
        const int count = manifests.size();
        const int next = current < 0 ? (direction > 0 ? 0 : count - 1) :
                (current + (direction > 0 ? 1 : -1) + count) % count;
        const bool active = !m_touching && ControlObject::get(ConfigKey(unitGroup(), "enabled")) > 0 &&
                ControlObject::get(ConfigKey(m_slot->getGroup(), "enabled")) > 0;
        QList<QPair<ConfigKey, double>> routes;
        for (const auto& group : {QString("[Master]"), QString("[Channel1]"), QString("[Channel2]")}) {
            const ConfigKey key(unitGroup(), "group_" + group + "_enable");
            if (ControlObject::exists(key)) routes.append({key, ControlObject::get(key)});
        }
        selectEffect(manifests[next], false);
        // Loading the empty placeholder can reset chain defaults. Preserve the
        // physical channel selector even on that first effect selection.
        for (const auto& route : routes) ControlObject::set(route.first, route.second);
        setActive(active);
    }
    void registerBank(int index, const EffectManifestPointer& manifest) {
        if (index < 0 || index >= 4 || !isRx3BeatFx(manifest)) return;
        m_ids[index] = manifest->uniqueId();
        m_config->setValue(bankKey(index), m_ids[index]); m_config->save(); refresh();
    }
    void clearBank(int index) {
        if (index < 0 || index >= 4) return;
        m_ids[index].clear(); m_config->setValue(bankKey(index), QString()); m_config->save(); refresh();
    }
    double amount() const {return m_config->getValue(ConfigKey("[RX3BeatFx]", "amount"), 0.5);}
    void setAmount(double value) {
        value = qBound(0.0, value, 1.0);
        m_config->setValue(ConfigKey("[RX3BeatFx]", "amount"), value);
        if(ControlObject::exists(ConfigKey("[RX3BeatFx]","amount"))) ControlObject::set(ConfigKey("[RX3BeatFx]","amount"),value);
        ControlObject::set(ConfigKey(unitGroup(), "mix"), value);
        refresh();
    }
    bool positionPad(double value) {
        if (!m_slot || !m_slot->isLoaded() || !m_pad->isEnabled()) return false;
        value = qBound(0.0, value, 1.0);
        if (m_pad->presentation() == WRx3XPad::Layout::Continuous) changeParameter(qRound(value * 1000));
        else if (!m_pad->cells().isEmpty()) {
            const auto cells = m_pad->cells();
            const int index = qMin(int(cells.size()) - 1, int(value * cells.size()));
            if (!cells[index].enabled || !m_pad->activateCell) return false;
            m_pad->activateCell(cells[index].target);
        }
        return true;
    }
    QString padValueText() const {return m_padValueText;}
    void stepPad(int delta) {
        if (!m_slot || !m_slot->isLoaded() || !m_pad->isEnabled() || !delta) return;
        const auto cells=m_pad->cells();
        double position=m_pad->value()/1000.0;
        if (cells.isEmpty()) position=qBound(0.0,position+delta*0.025,1.0);
        else {
            const auto parameter=m_parameter ? parameterForId(m_slot,m_parameter->getManifest()->id()) : EffectParameterPointer();
            if (!parameter) return;
            int current=-1;double distance=std::numeric_limits<double>::max();
            for(int i=0;i<cells.size();++i) if(cells[i].enabled && std::abs(cells[i].target-parameter->getValue())<distance) {
                distance=std::abs(cells[i].target-parameter->getValue());current=i;
            }
            if (current<0) return;
            const int direction=delta>0?1:-1;
            for(int tick=0;tick<qMin(qAbs(delta),int(cells.size()));++tick) {
                int next=current+direction;
                while(next>=0 && next<cells.size() && !cells[next].enabled) next+=direction;
                if(next<0 || next>=cells.size()) break;
                current=next;
            }
            position=(current+0.5)/cells.size();
        }
        ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_position"),position);
    }
    void recallBank(int index) {if (index >= 0 && index < 4) useBank(index);}
    void editBank(int index) {if (index >= 0 && index < 4 && m_slot) chooseEffect(index);}
    void setActive(bool active) {
        if (!m_slot || !m_slot->isLoaded()) return;
        rx3SetBeatFxEnabled(m_slot, active); ControlObject::set(ConfigKey(unitGroup(), "enabled"), active ? 1 : 0);
    }
    double effectBpm() const {
        if(ControlObject::exists(ConfigKey("[RX3BeatFx]","bpm_mode")) && ControlObject::get(ConfigKey("[RX3BeatFx]","bpm_mode"))>0)
            return qBound(40.0, ControlObject::get(ConfigKey("[RX3BeatFx]","bpm_manual")), 300.0);
        int routedDeck=0;
        for(int deck=1;deck<=2;++deck) {
            const auto key=ConfigKey(unitGroup(),QString("group_[Channel%1]_enable").arg(deck));
            if(ControlObject::exists(key) && ControlObject::get(key)>0) {
                if(routedDeck) return displayBpm();
                routedDeck=deck;
            }
        }
        if(routedDeck && ControlObject::exists(ConfigKey(QString("[Channel%1]").arg(routedDeck),"visual_bpm")))
            return ControlObject::get(ConfigKey(QString("[Channel%1]").arg(routedDeck),"visual_bpm"));
        return displayBpm();
    }
    double displayBpm() const {
        const ConfigKey key("[RX3Display]", "master_bpm");
        return ControlObject::exists(key) ? ControlObject::get(key) : 0;
    }
    EffectsManager* effectsManager() const {return m_effects;}
    QString bankId(int index) const { return m_ids.at(index); }
    QString parameterId() const { return m_parameter ? m_parameter->getManifest()->id() : QString(); }
  protected:
    void hideEvent(QHideEvent* event) override {
        m_pad->setSliderDown(false);
        m_delete->setChecked(false);
        if (m_effectMenu) m_effectMenu->close();
        QWidget::hideEvent(event);
    }
  private:
    void ensureControl(const QString& key, double initial, std::function<void(double)> callback) {
        const ConfigKey configKey("[RX3BeatFx]", key);
        if (!ControlObject::exists(configKey)) m_controls.push_back(std::make_unique<ControlObject>(configKey, true, false, false, initial));
        auto* proxy = new ControlProxy(configKey.group, configKey.item, this);
        proxy->connectValueChanged(this, std::move(callback));
    }
    std::vector<std::unique_ptr<ControlObject>> m_controls;
    using Units = EffectManifestParameter::UnitsHint;
    static ConfigKey bankKey(int index) {
        return ConfigKey("[RX3BeatFxBank]", QString("slot%1").arg(index + 1));
    }
    QLabel* caption(const QString& text) {
        auto* label = new QLabel(text, this);
        label->setObjectName("RX3StripCaption");
        label->setAlignment(Qt::AlignCenter);
        label->setFixedHeight(16);
        return label;
    }
    void releasePad() {
        if (!m_touching) return;
        m_touching = false;
        if(ControlObject::exists(ConfigKey("[RX3BeatFx]","xpad_hold"))) ControlObject::set(ConfigKey("[RX3BeatFx]","xpad_hold"),0);
        ControlObject::set(ConfigKey(unitGroup(), "enabled"), 0);
    }
    void chooseEffect(int index) {
        if (m_effectMenu) m_effectMenu->close();
        auto* menu = new QMenu(this);
        menu->setObjectName("RX3BankEffectMenu");
        menu->setAttribute(Qt::WA_DeleteOnClose);
        m_effectMenu = menu;
        const auto previousId = m_ids[index];
        const auto manifests = rx3BeatFxManifests(m_effects->getBackendManager());
        for (const auto& manifest : manifests) {
            auto* action = menu->addAction(manifest->displayName().toUpper());
            const auto id = manifest->uniqueId();
            action->setData(id);
            connect(action, &QAction::triggered, this, [this, index, id, previousId] {
                if (!m_slot || m_ids[index] != previousId) return;
                const auto selected = m_effects->getBackendManager()->getManifestFromUniqueId(id);
                if (!isRx3BeatFx(selected)) return;
                if (!m_slot->getManifest() || m_slot->getManifest()->uniqueId() != id) {
                    rx3LoadBeatFx(m_slot, selected);
                }
                m_ids[index] = id;
                m_config->setValue(bankKey(index), id);
                m_config->save();
                refresh();
            });
        }
        if (menu->isEmpty()) {
            menu->addAction("No effects available")->setEnabled(false);
        }
        menu->popup(m_buttons[index]->mapToGlobal(QPoint(0, m_buttons[index]->height())));
    }
    void useBank(int index) {
        if (!m_slot) return;
        if (m_delete->isChecked()) {
            m_ids[index].clear();
            m_config->setValue(bankKey(index), QString());
            m_config->save();
            m_delete->setChecked(false);
        } else if (m_ids[index].isEmpty()) {
            chooseEffect(index);
            return;
        } else {
            const auto manifest = m_effects->getBackendManager()->getManifestFromUniqueId(m_ids[index]);
            if (!manifest) return;
            // Repair a previously saved utility processor only after an
            // explicit choice; keep unavailable registrations recoverable.
            if (!isRx3BeatFx(manifest)) { chooseEffect(index); return; }
            if (!m_slot->getManifest() || m_slot->getManifest()->uniqueId() != m_ids[index])
                rx3LoadBeatFx(m_slot, manifest);
            rx3SetBeatFxEnabled(m_slot, true);
            ControlObject::set(ConfigKey(unitGroup(), "enabled"), 1);
        }
        refresh();
    }
    void bindParameter() {
        m_pad->setSliderDown(false);
        for (const auto& connection : m_parameterConnections) disconnect(connection);
        m_parameterConnections.clear();
        m_parameter.clear();
        if (m_slot && m_slot->isLoaded()) {
            const auto effect = m_slot->id();
            // Contextual controls for available Mixxx processors. Other effects
            // use their beat/time/pitch/frequency control or first exposed knob.
            QString preferred;
            if (effect.endsWith(".reverb")) preferred = "decay";
            else if (effect.endsWith(".flanger")) preferred = "speed";
            else if (effect.endsWith(".phaser")) preferred = "lfo_period";
            else if (effect.endsWith(".pitchshift")) preferred = "pitch";
            else if (effect.endsWith(".filter")) preferred = "lpf";
            int best = -1;
            for (unsigned int index = 0; index < m_slot->numParameters(EffectParameterType::Knob); ++index) {
                auto parameter = m_slot->getEffectParameterSlot(EffectParameterType::Knob, index);
                const auto manifest = parameter->getManifest();
                if (!manifest) continue;
                const auto units = manifest->unitsHint();
                const int score = !preferred.isEmpty() && manifest->id() == preferred ? 100 :
                        units == Units::Beats || units == Units::Beat ? 80 :
                        units == Units::Seconds || units == Units::Millisecond ? 60 :
                        units == Units::Semitone12tet || units == Units::Hertz ? 40 : 0;
                if (score > best) { best = score; m_parameter = parameter; }
            }
            for (const auto type : {EffectParameterType::Knob, EffectParameterType::Button})
                for (unsigned int index = 0; index < m_slot->numParameters(type); ++index)
                    m_parameterConnections.push_back(connect(
                            m_slot->getEffectParameterSlot(type, index).data(),
                            &EffectParameterSlotBase::valueChanged, this, [this] { refresh(); }));
        }
        refresh();
    }
    void changeParameter(int value) {
        if (!m_slot || !m_slot->isLoaded()) return;
        const double normalized = value / 1000.0;
        if (m_parameter) m_parameter->setParameter(normalized);
        else m_slot->setMetaParameter(normalized, true);
        refresh();
    }
    void refresh() {
        const bool loaded = m_slot && m_slot->isLoaded();
        const auto current = loaded ? m_slot->getManifest()->uniqueId() : QString();
        for (int index = 0; index < 4; ++index) {
            const auto manifest = m_effects && !m_ids[index].isEmpty() ?
                    m_effects->getBackendManager()->getManifestFromUniqueId(m_ids[index]) : EffectManifestPointer();
            const bool supported = isRx3BeatFx(manifest);
            m_buttons[index]->setText(supported ? manifest->displayName().toUpper() : QString());
            m_buttons[index]->setToolTip(m_ids[index].isEmpty() ? "Choose a Beat FX for this empty slot." :
                    supported ? QString("Press to activate. Hold to replace %1").arg(manifest->displayName()) : manifest ? "Choose a supported Beat FX to replace this registration." :
                    "This saved effect is unavailable. Delete the registration to reuse this slot.");
            m_buttons[index]->setEnabled(m_slot != nullptr);
            const bool selected = supported && current == m_ids[index];
            const bool empty = !supported;
            if (m_buttons[index]->property("selected").toBool() != selected ||
                    !m_buttons[index]->property("empty").isValid() ||
                    m_buttons[index]->property("empty").toBool() != empty) {
                m_buttons[index]->setProperty("selected", selected);
                m_buttons[index]->setProperty("empty", empty);
                m_buttons[index]->style()->unpolish(m_buttons[index]);
                m_buttons[index]->style()->polish(m_buttons[index]);
            }
        }
        QSignalBlocker blocker(m_pad);
        m_pad->setEnabled(loaded);
        if (!loaded) m_pad->present(WRx3XPad::Layout::Empty, {}, 0);
        QString readout = "—", milliseconds = "—";
        if (loaded) {
            double normalized = m_slot->getMetaParameter();
            if (auto knob = qSharedPointerDynamicCast<EffectKnobParameterSlot>(m_parameter))
                normalized = knob->getValueParameter();
            m_pad->setValue(qRound(qBound(0.0, normalized, 1.0) * 1000));
            if (m_parameter) {
                const auto manifest = m_parameter->getManifest();
                const auto parameter = parameterForId(m_slot, manifest->id());
                double value = parameter ? parameter->getValue() : 0;
                const auto units = manifest->unitsHint();
                const bool flanger = m_slot->id().endsWith(".flanger") && manifest->id() == "speed";
                QList<WRx3XPad::Cell> cells;
                auto layout = WRx3XPad::Layout::Continuous;
                if (units == Units::Beats || units == Units::Beat) {
                    layout = WRx3XPad::Layout::Beats;
                    const QStringList labels{"1/16", "1/8", "1/4", "1/2", "3/4", "1", "2", "4"};
                    const double beats[] = {0.0625, 0.125, 0.25, 0.5, 0.75, 1, 2, 4};
                    for (int index = 0; index < 8; ++index) {
                        double target = beats[index];
                        double minimumBeat = manifest->getMinimum();
                        if (m_slot->id().endsWith(".echo") || m_slot->id().endsWith(".phaser")) minimumBeat = 1.0 / 16;
                        else if (m_slot->id().endsWith(".glitch")) minimumBeat = 0.125;
                        else if (m_slot->id().endsWith(".tremolo")) {minimumBeat = 0; target = 1 / target;}
                        const double bpm = effectBpm();
                        const bool fitsBuffer = !m_slot->id().endsWith(".echo") || bpm <= 0 || beats[index] * 60 / bpm <= 6;
                        const bool supported = fitsBuffer && beats[index] >= minimumBeat &&
                                target >= manifest->getMinimum() && target <= manifest->getMaximum();
                        cells.append({labels[index], target, supported});
                    }
                } else if (m_slot->id().endsWith(".pitchshift") && manifest->id() == "pitch") {
                    layout = WRx3XPad::Layout::Pitch;
                    const auto range = parameterForId(m_slot, "range");
                    const double span = 12 * (range && range->getValue() > 0 ? range->getValue() : 1);
                    for (const double semitones : {-12.0, -7.0, -5.0, 0.0, 5.0, 7.0, 12.0}) {
                        const double target = span > 0 ? semitones / span : 0;
                        cells.append({(semitones > 0 ? "+" : "") + QString::number(semitones),
                                target, std::abs(target) <= 1});
                    }
                }
                const auto pitchRange = layout == WRx3XPad::Layout::Pitch ? parameterForId(m_slot, "range") : EffectParameterPointer();
                m_pad->present(layout, cells, pitchRange && pitchRange->getValue() <= 0 ? 0 : value);
                if (units == Units::Beat || units == Units::Beats || flanger) {
                    const double bpm = effectBpm();
                    const bool beatTime = bpm > 0 && std::isfinite(bpm);
                    const auto quantize = parameterForId(m_slot, "quantize");
                    const auto triplet = parameterForId(m_slot, "triplet");
                    const bool quantized = quantize && quantize->getValue() > 0;
                    const bool triplets = triplet && triplet->getValue() > 0;
                    const auto exact = parameterForId(m_slot, "rx3_exact_time");
                    const bool exactTime = exact && exact->getValue() > 0;
                    if (m_slot->id().endsWith(".echo")) {
                        value = rx3::echoPeriod(value, beatTime, quantized, triplets, exactTime);
                    } else if (m_slot->id().endsWith(".phaser")) {
                        value = rx3::phaserPeriod(value, beatTime, triplets, exactTime);
                    } else if (flanger) {
                        value = qMax(0.25, beatTime ? std::round(value * 2) / 2 : value);
                        if (beatTime && triplets) value /= 3;
                    } else if (m_slot->id().endsWith(".glitch")) {
                        if (beatTime && quantized) {value = std::round(value * 8) / 8; if (triplets) value /= 3;}
                        if (beatTime) value = qMax(0.125, value);
                    } else if (m_slot->id().endsWith(".tremolo") && manifest->id() == "rate") {
                        value = 1.0 / rx3::tremoloRate(value, beatTime, quantized, triplets, exactTime);
                    }
                    readout = QString::number(value, 'g', 3) + (beatTime ? " BEAT" : " SEC");
                    milliseconds = QString::number(qRound(value * (beatTime ? 60000 / bpm : 1000)));
                } else {
                    if (layout == WRx3XPad::Layout::Pitch) {
                        const auto range = parameterForId(m_slot, "range");
                        readout = QString::number(value * 12 * (range ? range->getValue() : 1), 'g', 3) + " ST";
                    } else readout = manifest->shortName() + " " + QString::number(value, 'g', 3);
                    if (units == Units::Seconds) milliseconds = QString::number(qRound(value * 1000));
                    else if (units == Units::Millisecond) milliseconds = QString::number(qRound(value));
                }
                m_pad->setToolTip(manifest->name());
            } else {
                m_pad->present(WRx3XPad::Layout::Continuous, {}, 0);
                readout = QString("%1%").arg(qRound(normalized * 100));
                m_pad->setToolTip("Effect metaknob");
            }
        }
        auto* canvas = parentWidget()->window();
        auto setReadout = [canvas](const QString& name, const QString& text) {
            if (auto* label = canvas->findChild<QLabel*>(name)) {
                QString formatted = text;
                const int fontPixels = QFontInfo(label->font()).pixelSize();
                if (name == "RX3BeatFxMilliseconds")
                    formatted = rx3::smallSuffix(text, " msec", fontPixels);
                else if (name == "RX3BeatFxBeat" && text.endsWith(" BEAT"))
                    formatted = rx3::smallSuffix(text.left(text.size() - 5), " BEAT", fontPixels);
                // WLabel stores its full text separately and reapplies it on
                // resize. Calling only QLabel::setText would lose this update.
                if (auto* skinLabel = qobject_cast<WLabel*>(label)) skinLabel->setText(formatted);
                else label->setText(formatted);
            }
        };
        m_padValueText=readout;
        setReadout("RX3BeatFxBeat", readout);
        const ConfigKey bpmKey("[RX3BeatFx]","bpm");
        if(ControlObject::exists(bpmKey)) ControlObject::set(bpmKey,effectBpm());
        setReadout("RX3BeatFxMilliseconds", milliseconds);
    }
    UserSettingsPointer m_config;
    EffectsManager* m_effects;
    EffectSlotPointer m_slot;
    EffectParameterSlotBasePointer m_parameter;
    QList<QMetaObject::Connection> m_parameterConnections;
    std::array<QString, 4> m_ids;
    std::array<QPushButton*, 4> m_buttons{};
    QPushButton* m_delete;
    WRx3XPad* m_pad;
    QPointer<QMenu> m_effectMenu;
    QString m_padValueText;
    bool m_touching = false;
};
