#pragma once

#include <QElapsedTimer>
#include <QFrame>
#include <QGridLayout>
#include <QLabel>
#include <QMouseEvent>
#include <QPainter>
#include <QPointer>
#include <QPushButton>
#include <QStackedLayout>
#include <QTimer>
#include <QVBoxLayout>
#include <algorithm>
#include <functional>
#include <memory>
#include <QFontInfo>
#include "control/controlobject.h"
#include "control/controlproxy.h"
#include "preferences/usersettings.h"

// Monotonic wall time: audio callbacks, deck tempo and hiding the editor do
// not affect the deadline. The editor never seeks or changes either deck.
class Rx3Countdown {
  public:
    void setSeconds(int seconds) {m_leftMs=std::clamp(seconds,0,359999)*1000LL;m_totalMs=m_leftMs;m_running=false;}
    void start() {if(m_leftMs<=0) return;m_totalMs=std::max(m_totalMs,m_leftMs);m_clock.restart();m_running=true;}
    void pause() {m_leftMs=remainingMs();m_running=false;}
    qint64 remainingMs() const {return std::max(qint64(0),m_leftMs-(m_running?m_clock.elapsed():0));}
    int seconds() const {return int((remainingMs()+999)/1000);}
    bool running() const {return m_running && remainingMs()>0;}
    double fraction() const {return m_totalMs>0?double(remainingMs())/m_totalMs:0;}
    static QString text(int seconds) {
        return QString("%1:%2:%3").arg(seconds/3600,2,10,QChar('0'))
                .arg(seconds/60%60,2,10,QChar('0')).arg(seconds%60,2,10,QChar('0'));
    }
  private:
    QElapsedTimer m_clock;qint64 m_leftMs=0,m_totalMs=0;bool m_running=false;
};

class Rx3CountdownRail : public QPushButton {
  public:
    Rx3CountdownRail(Rx3Countdown* timer,std::function<void()> open,QWidget* parent)
            :QPushButton("REMAIN",parent),m_timer(timer),m_open(std::move(open)) {
        setObjectName("RX3CountdownRail");setAccessibleName("Open countdown timer");
        setCursor(Qt::PointingHandCursor);
        connect(this,&QPushButton::clicked,this,[this]{m_open();});
    }
  protected:
    void paintEvent(QPaintEvent*) override {
        QPainter painter(this);painter.fillRect(rect(),QColor("#202020"));
        const double scale=height()/28.0;
        QFont font("Arial");font.setPixelSize(qMax(9,qRound(13*scale)));painter.setFont(font);
        painter.setPen(QColor("#ddd"));
        // A vector stopwatch stays legible regardless of the platform's font.
        painter.save();painter.setRenderHint(QPainter::Antialiasing);
        painter.translate(8*scale,height()/2.0-7*scale);painter.scale(scale,scale);
        painter.setPen(QPen(QColor("#ddd"),1.2,Qt::SolidLine,Qt::RoundCap,Qt::RoundJoin));
        painter.drawEllipse(QRectF(1,4,10,10));
        painter.drawLine(QPointF(6,1),QPointF(6,4));
        painter.drawLine(QPointF(4,1),QPointF(8,1));
        painter.drawLine(QPointF(10,4),QPointF(11,3));
        painter.drawLine(QPointF(6,6),QPointF(6,9));
        painter.drawLine(QPointF(6,9),QPointF(8,10));painter.restore();
        painter.drawText(QRectF(26*scale,0,140*scale,height()),Qt::AlignVCenter,
                "REMAIN  "+Rx3Countdown::text(m_timer->seconds()));
        const QRectF bar(170*scale,height()/2.0-2*scale,qMax(0.0,width()-178*scale),4*scale);
        painter.fillRect(bar,QColor("#111111"));
        painter.fillRect(QRectF(bar.topLeft(),QSizeF(bar.width()*m_timer->fraction(),bar.height())),Qt::white);
    }
  private:
    Rx3Countdown* m_timer;std::function<void()> m_open;
};

class WRx3Countdown : public QFrame {
  public:
    WRx3Countdown(UserSettingsPointer config,QWidget* canvas)
            :QFrame(canvas),m_config(std::move(config)),m_canvas(canvas) {
        setObjectName("RX3Countdown");setAttribute(Qt::WA_StyledBackground);
        setStyleSheet("#RX3Countdown {background:#202020;color:white;border:0;} "
                "#RX3Countdown QLabel {color:#ddd;background:transparent;font-family:Arial;font-size:15px;} "
                "#RX3Countdown QPushButton {background:#303030;color:#eee;border:1px solid #777;"
                "font-family:Arial;font-size:26px;font-weight:normal;padding:2px;} "
                "#RX3Countdown QPushButton:pressed {background:#007CE0;} "
                "#RX3Countdown QPushButton:disabled {color:#777;border-color:#444;} "
                "#RX3Countdown #CountdownReadout {font-size:64px;color:white;background:black;} ");
        auto* layout=new QHBoxLayout(this);layout->setContentsMargins(18,16,18,16);layout->setSpacing(20);
        auto* presets=new QVBoxLayout;auto* history=new QVBoxLayout;
        layout->addLayout(presets,1);layout->addLayout(history,1);
        presets->addWidget(new QLabel("PRESET",this));history->addWidget(new QLabel("HISTORY",this));
        const QList<int> values{7200,5400,3600,3000,2400,1800};
        for(int index=0;index<values.size();++index) {
            const int value=values[index];
            auto* preset=button(shortText(value),"Preset"+QString::number(index),presets);
            connect(preset,&QPushButton::clicked,this,[this,value]{setSeconds(value);});
            auto* recent=button("","History"+QString::number(index),history);m_historyButtons.append(recent);
            connect(recent,&QPushButton::clicked,this,[this,index]{if(index<m_history.size()) setSeconds(m_history[index]);});
        }
        auto* editor=new QFrame(this);editor->setStyleSheet("QFrame {background:black;border:0;}");
        layout->addWidget(editor,4);auto* edit=new QVBoxLayout(editor);edit->setContentsMargins(16,12,16,16);edit->setSpacing(14);
        auto* display=new QHBoxLayout;edit->addLayout(display);
        m_readout=new QLabel(this);m_readout->setObjectName("CountdownReadout");m_readout->setAlignment(Qt::AlignCenter);m_readout->setFixedHeight(108);
        display->addWidget(m_readout,3);m_start=button("START","Start",display);display->setStretch(1,1);m_start->setFixedHeight(76);
        connect(m_start,&QPushButton::clicked,this,[this]{
            if(m_timer.running()) m_timer.pause();
            else if(m_timer.seconds()>0) {remember(m_timer.seconds());m_timer.start();m_digits.clear();}
            refresh();
        });
        auto* keypad=new QGridLayout;keypad->setSpacing(10);edit->addLayout(keypad,1);
        for(int index=0;index<9;++index) {
            const int digit=9-(index/3)*3-2+index%3;
            auto* key=new QPushButton(QString::number(digit),this);key->setObjectName("CountdownDigit"+QString::number(digit));
            keypad->addWidget(key,index/3,index%3);
            connect(key,&QPushButton::clicked,this,[this,digit]{digitInput(digit);});
        }
        auto* zero=new QPushButton("0",this);zero->setObjectName("CountdownDigit0");keypad->addWidget(zero,3,0,1,3);
        connect(zero,&QPushButton::clicked,this,[this]{digitInput(0);});
        for(int row=0;row<4;++row) {
            const int delta=QList<int>{300,-300,60,-60}[row];
            auto* key=new QPushButton(QString(delta>0?"+":"−")+QString::number(std::abs(delta)/60)+"m",this);
            key->setObjectName("CountdownAdjust"+QString::number(delta));keypad->addWidget(key,row,3);
            connect(key,&QPushButton::clicked,this,[this,delta]{setSeconds(m_timer.seconds()+delta);});
        }
        auto* actions=new QVBoxLayout;keypad->addLayout(actions,0,4,4,1);
        auto* clear=button("CLR","Clear",actions);connect(clear,&QPushButton::clicked,this,[this]{setSeconds(0);});
        auto* remain=button("REMAIN","Remain",actions);connect(remain,&QPushButton::clicked,this,[this]{setOpen(false);});actions->addStretch();
        for(int row=0;row<4;++row) keypad->setRowStretch(row,1);
        for(int col=0;col<4;++col) keypad->setColumnStretch(col,1);keypad->setColumnStretch(4,2);
        const auto saved=m_config->getValueString(ConfigKey("[RX3Countdown]","history")).split(',');
        for(const auto& value:saved) {bool ok=false;const int seconds=value.toInt(&ok);if(ok && seconds>0 && seconds<=359999 && m_history.size()<6) m_history.append(seconds);}
        m_timer.setSeconds(m_config->getValue<int>(ConfigKey("[RX3Countdown]","duration"),0));
        m_waveforms=canvas->findChild<QWidget*>("Waveforms");
        m_stack=m_waveforms?qobject_cast<QStackedLayout*>(m_waveforms->layout()):nullptr;
        if(m_stack) {setParent(m_waveforms);m_stack->addWidget(this);}
        auto* rail=canvas->findChild<QWidget*>("RX3TransportRail");
        if(rail) {
            for(auto* widget:rail->findChildren<QWidget*>(QString(),Qt::FindDirectChildrenOnly)) widget->hide();
            rail->installEventFilter(this);m_rail=new Rx3CountdownRail(&m_timer,[this]{setOpen(!m_open);},rail);
            m_rail->setGeometry(rail->rect());m_rail->show();
        }
        if(!ControlObject::exists(ConfigKey("[RX3Countdown]","visible")))
            m_visible=std::make_unique<ControlObject>(ConfigKey("[RX3Countdown]","visible"));
        auto* visibility=new ControlProxy("[RX3Countdown]","visible",this);
        visibility->connectValueChanged(this,[this](double value){if((value>0)!=m_open) setOpen(value>0);});
        auto* page=new ControlProxy("[Tab]","current",this,ControlFlag::NoAssertIfMissing);
        page->connectValueChanged(this,[this](double value){if(value!=0 && m_open) setOpen(false);});
        auto* tick=new QTimer(this);tick->setInterval(100);connect(tick,&QTimer::timeout,this,[this]{refresh();});tick->start();
        hide();refresh();
    }
    ~WRx3Countdown() override {if(m_rail) delete m_rail.data();}
    void setSeconds(int seconds) {
        m_digits.clear();m_timer.setSeconds(seconds);
        m_config->setValue(ConfigKey("[RX3Countdown]","duration"),m_timer.seconds());m_config->save();refresh();
    }
    void setOpen(bool open) {
        if(open==m_open) return;
        m_open=open;
        if(m_stack) {
            if(open) {m_previousIndex=m_stack->currentIndex();m_stack->setStackingMode(QStackedLayout::StackOne);m_stack->setCurrentWidget(this);show();}
            else {
                m_stack->setCurrentIndex(m_previousIndex);m_stack->setStackingMode(QStackedLayout::StackAll);hide();
                // StackAll shows siblings, so reinstate the skin's empty-state rules.
                if(auto* logo=m_canvas->findChild<QWidget*>("NauticBgLogoContainer"))
                    logo->setVisible(ControlObject::get(ConfigKey("[Channel1]","track_loaded"))==0);
                if(auto* logo=m_canvas->findChild<QWidget*>("NauticBgLogo"))
                    logo->setVisible(ControlObject::get(ConfigKey("[Channel2]","track_loaded"))==0);
            }
        } else setVisible(open);
        ControlObject::set(ConfigKey("[RX3Countdown]","visible"),open?1:0);
        refresh();
    }
    const Rx3Countdown& countdown() const {return m_timer;}
  protected:
    bool eventFilter(QObject* object,QEvent* event) override {
        if(m_rail && object==m_rail->parentWidget() && event->type()==QEvent::Resize) m_rail->setGeometry(m_rail->parentWidget()->rect());
        return QFrame::eventFilter(object,event);
    }
  private:
    template<class Layout> QPushButton* button(const QString& text,const QString& name,Layout* layout) {
        auto* button=new QPushButton(text,this);button->setObjectName("Countdown"+name);button->setMinimumHeight(42);
        button->setSizePolicy(QSizePolicy::Expanding,QSizePolicy::Expanding);layout->addWidget(button);return button;
    }
    static QString shortText(int seconds) {if(seconds%60) return Rx3Countdown::text(seconds);return QString("%1h:%2m").arg(seconds/3600,2,10,QChar('0')).arg(seconds/60%60,2,10,QChar('0'));}
    void digitInput(int digit) {
        if(m_digits.size()>=6) m_digits.clear();m_digits+=QString::number(digit);
        const int raw=m_digits.toInt();m_timer.setSeconds(std::min(raw/10000,99)*3600+std::min(raw/100%100,59)*60+std::min(raw%100,59));
        refresh();
    }
    void remember(int seconds) {
        m_history.removeAll(seconds);m_history.prepend(seconds);while(m_history.size()>6) m_history.removeLast();
        QStringList values;for(const int item:m_history) values.append(QString::number(item));
        m_config->setValue(ConfigKey("[RX3Countdown]","history"),values.join(','));
        m_config->setValue(ConfigKey("[RX3Countdown]","duration"),seconds);m_config->save();
    }
    void refresh() {
        const int seconds=m_timer.seconds();
        const int suffix=qMax(12,QFontInfo(m_readout->font()).pixelSize()/3);
        m_readout->setText(QString("%1<span style='font-size:%4px'>h</span> : %2<span style='font-size:%4px'>m</span> : %3<span style='font-size:%4px'>s</span>")
                .arg(seconds/3600,2,10,QChar('0')).arg(seconds/60%60,2,10,QChar('0')).arg(seconds%60,2,10,QChar('0')).arg(suffix));
        m_start->setText(m_timer.running()?"STOP":"START");
        m_start->setEnabled(m_timer.seconds()>0);
        for(int index=0;index<m_historyButtons.size();++index) {
            m_historyButtons[index]->setText(index<m_history.size()?shortText(m_history[index]):"");
            m_historyButtons[index]->setEnabled(index<m_history.size());
        }
        if(m_rail) m_rail->update();
    }
    UserSettingsPointer m_config;QWidget* m_canvas;QWidget* m_waveforms=nullptr;QStackedLayout* m_stack=nullptr;
    Rx3Countdown m_timer;QPointer<Rx3CountdownRail> m_rail;QLabel* m_readout=nullptr;QPushButton* m_start=nullptr;
    QVector<QPushButton*> m_historyButtons;QList<int> m_history;QString m_digits;
    std::unique_ptr<ControlObject> m_visible;bool m_open=false;int m_previousIndex=0;
};
