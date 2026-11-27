#pragma once

#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QPointer>
#include <QPushButton>
#include <QResizeEvent>
#include <QVBoxLayout>
#include <functional>
#include <algorithm>
#include <QStyle>
#include <optional>
#include "library/rekordbox/rekordboxfeature.h"
#include "track/track.h"

namespace rx3 {
struct InfoTrack {
    QString location,root,artwork,comment;
    QStringList values{QString(),QString(),QString(),QString(),QString(),QString(),QString(),QString(),QString(),QString()};
    TrackPointer loaded;
    std::optional<mixxx::rekordbox::RuntimeTrack> record;
    int rating=0,number=0,total=0;
    bool canJump() const {return record.has_value() && !root.isEmpty();}
};
inline InfoTrack infoTrack(RekordboxFeature* feature,const QString& location,TrackPointer loaded={}) {
    InfoTrack info;info.location=location;
    info.loaded = loaded;
    if(feature) info.record=feature->infoForLocation(location,&info.root);
    if(info.record) {
        const auto& track=*info.record;
        const int seconds=int(track.durationSeconds.value_or(0));
        info.rating=int(track.rating.value_or(0));info.artwork=track.resolvedArtworkPath;info.comment=track.comment;
        info.values={track.title,track.artist,track.album,
            QString("%1:%2").arg(seconds/60,2,10,QChar('0')).arg(seconds%60,2,10,QChar('0')),
            track.bpm?QString::number(*track.bpm,'f',1)+" bpm":QString(),track.key,QString(),
            track.rawMetadata.value("color_name").toString(),track.genre,track.rawMetadata.value("date_added").toString()};
        info.number=track.rawMetadata.value("track_number").toInt();
    } else if(loaded) {
        const int seconds=qMax(0,int(loaded->getDuration()));
        info.rating=loaded->getRating();info.comment=loaded->getComment();
        info.values={loaded->getTitle(),loaded->getArtist(),loaded->getAlbum(),
            QString("%1:%2").arg(seconds/60,2,10,QChar('0')).arg(seconds%60,2,10,QChar('0')),
            loaded->getBpm()>0?QString::number(loaded->getBpm(),'f',1)+" bpm":QString(),loaded->getKeyText(),QString(),
            QString(),loaded->getGenre(),loaded->getDateAdded().date().toString(Qt::ISODate)};
    }
    return info;
}
}

// Same metadata presentation for loaded decks and the highlighted Browse row.
// Selecting/inspecting a row never projects a new audio track or starts analysis.
class Rx3TrackInfoPanel : public QFrame {
  public:
    explicit Rx3TrackInfoPanel(RekordboxFeature* feature,QWidget* parent=nullptr)
            :QFrame(parent),m_feature(feature) {
        setObjectName("RX3DetailedInfo");setAttribute(Qt::WA_StyledBackground);
        setStyleSheet("#RX3DetailedInfo {background:#000;color:white;border:0;} "
            "#RX3DetailedInfo QListWidget {background:#202020;color:white;border:0;font-family:Arial;font-size:19px;} "
            "#RX3DetailedInfo QListWidget::item {padding:3px 12px;border-bottom:1px solid #303030;} "
            "#RX3DetailedInfo QListWidget::item:selected {background:#007CE0;} "
            "#RX3DetailedInfo QLabel {color:white;background:transparent;font-family:Arial;font-size:18px;} "
            "#RX3DetailedInfo QPushButton {background:#202020;color:white;border:1px solid #777;font-family:Arial;font-size:18px;} "
            "#RX3DetailedInfo QPushButton[chosen=\"true\"] {background:#007CE0;}");
        auto* layout=new QHBoxLayout(this);layout->setContentsMargins(8,0,8,0);layout->setSpacing(16);
        m_fields=new QListWidget(this);m_fields->setObjectName("RX3InfoFields");
        m_fields->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);layout->addWidget(m_fields,6);
        const QStringList names={"Title","Artist","Album","Duration","BPM","Key","Rating","Color","Genre","Date added"};
        for(const auto& name:names) {auto* item=new QListWidgetItem(m_fields);item->setData(Qt::AccessibleTextRole,name);}
        m_fields->setCurrentRow(0);
        connect(m_fields,&QListWidget::itemClicked,this,[this](QListWidgetItem*){enter();});
        auto* right=new QVBoxLayout;right->setSpacing(10);layout->addLayout(right,5);
        m_trackNumber=new QLabel(this);m_trackNumber->setAlignment(Qt::AlignCenter);right->addWidget(m_trackNumber);
        m_artwork=new QLabel(this);m_artwork->setAlignment(Qt::AlignCenter);m_artwork->setMinimumSize(1,1);right->addWidget(m_artwork,1);
        m_comment=new QLabel(this);m_comment->setWordWrap(true);right->addWidget(m_comment,1);
        m_ratingRow=new QFrame(this);auto* stars=new QHBoxLayout(m_ratingRow);stars->setContentsMargins(0,0,0,0);
        for(int value=0;value<=5;++value) {
            auto* button=new QPushButton(value==0?QString("0"):QString(QString::number(value)+" ★"),m_ratingRow);
            button->setAccessibleName(QString("Rating %1 stars").arg(value));
            connect(button,&QPushButton::clicked,this,[this,value]{if(!m_busy && m_data.canJump()){m_pending=value;commit();}});
            stars->addWidget(button);m_stars.append(button);
        }
        right->addWidget(m_ratingRow);m_ratingRow->hide();
        m_save = new QPushButton("SAVE CUES / LOOPS / GRID TO USB", this);
        right->addWidget(m_save);
        connect(m_save, &QPushButton::clicked, this, [this] {
            if (m_busy || !m_feature || !m_data.loaded || !m_data.record) return;
            m_busy = true; m_save->setEnabled(false); m_status->setText("Saving performance data to USB…");
            QPointer<Rx3TrackInfoPanel> guard(this);
            m_feature->savePerformance(m_data.root, m_data.loaded, [guard](QString error) {
                if (!guard) return;
                guard->m_busy = false;
                guard->m_status->setText(error.isEmpty() ? "Cues, loops and grid saved to USB." : error);
                guard->m_save->setEnabled(true);
            });
        });
        m_status=new QLabel(this);m_status->setWordWrap(true);right->addWidget(m_status);
        connect(m_fields,&QListWidget::currentRowChanged,this,[this](int row){m_ratingRow->setVisible(row==6 && m_data.canJump());});
    }
    void setTrack(const rx3::InfoTrack& data) {
        if(m_busy || m_held) return;
        const bool changed=data.location!=m_data.location;
        m_data=data;m_pending=data.rating;
        m_save->setVisible(bool(data.loaded) && bool(data.record));
        if(changed) {m_status->clear();m_fields->setCurrentRow(0);}
        if(data.artwork!=m_artworkPath) {m_artworkPath=data.artwork;m_pixmap=data.artwork.isEmpty()?QPixmap():QPixmap(data.artwork);}
        refresh();
    }
    const rx3::InfoTrack& track() const {return m_data;}
    void setJump(std::function<void(const QString&,const rx3::InfoTrack&)> callback) {m_jump=std::move(callback);}
    void setRefresh(std::function<void()> callback) {m_refresh=std::move(callback);}
    void move(int delta) {
        if(m_busy) return;
        if(m_held && m_fields->currentRow()==6 && m_data.canJump()) {
            m_pending=std::clamp(m_pending+delta,0,5);refresh();
        } else m_fields->setCurrentRow(std::clamp(m_fields->currentRow()+delta,0,9));
    }
    void hold(bool held) {
        const bool released=m_held && !held;m_held=held;
        if(released && m_pending!=m_data.rating) commit();
        if(released && !m_busy && m_refresh) m_refresh();
    }
    void enter() {
        if(m_busy || !m_jump) return;
        static const QStringList keys={"title","artist","album","","bpm","key","","color","genre",""};
        const auto key=keys.value(m_fields->currentRow());
        if(key=="title" || (m_data.canJump() && !key.isEmpty() && !m_data.values.value(m_fields->currentRow()).isEmpty()))
            m_jump(key,m_data);
    }
  protected:
    void resizeEvent(QResizeEvent* event) override {QFrame::resizeEvent(event);refresh();}
  private:
    void refresh() {
        static const QStringList prefixes={"♫  ","♙  ","▣  ","◷  ","BPM  ","♯  ","","○  ","▣  ","▦  "};
        for(int row=0;row<10;++row) {
            auto* item=m_fields->item(row);item->setSizeHint(QSize(1,qMax(26,m_fields->height()/10)));
            item->setText(row==6?QString(m_pending,QChar(0x2605))+QString(5-m_pending,QChar(0x2606)):prefixes[row]+m_data.values.value(row));
            item->setToolTip(m_data.values.value(row));
        }
        m_trackNumber->setText(m_data.location.isEmpty()?"No track selected":m_data.number>0?
                QString("TRACK %1%2").arg(m_data.number,3,10,QChar('0')).arg(m_data.total>0?QString("/%1").arg(m_data.total,3,10,QChar('0')):QString()):"TRACK INFO");
        m_comment->setText(m_data.comment);
        m_artwork->setPixmap(m_pixmap.isNull()?QPixmap():m_pixmap.scaled(m_artwork->size(),Qt::KeepAspectRatio,Qt::SmoothTransformation));
        m_ratingRow->setVisible(m_fields->currentRow()==6 && m_data.canJump());
        for(int i=0;i<m_stars.size();++i) {m_stars[i]->setProperty("chosen",i==m_pending);m_stars[i]->setEnabled(!m_busy);m_stars[i]->style()->unpolish(m_stars[i]);m_stars[i]->style()->polish(m_stars[i]);}
    }
    void commit() {
        if(m_busy || !m_feature || !m_data.canJump() || m_pending==m_data.rating) return;
        m_busy=true;m_status->setText("Saving rating to USB…");refresh();
        const int value=m_pending;const QPointer<Rx3TrackInfoPanel> guard(this);
        m_feature->writeRating(m_data.root,m_data.record->rekordboxId,value,[guard,value](const QString& error){
            if(!guard) return;
            guard->m_busy=false;
            if(error.isEmpty()) {guard->m_data.rating=value;guard->m_data.record->rating=quint32(value);guard->m_status->setText("Rating saved to USB.");}
            else {guard->m_pending=guard->m_data.rating;guard->m_status->setText(error);}
            guard->refresh();
            if(guard->m_refresh) guard->m_refresh();
        });
    }
    RekordboxFeature* m_feature;rx3::InfoTrack m_data;
    QPushButton* m_save;
    QListWidget* m_fields;QLabel *m_artwork,*m_comment,*m_trackNumber,*m_status;QFrame* m_ratingRow;
    QVector<QPushButton*> m_stars;QPixmap m_pixmap;QString m_artworkPath;int m_pending=0;bool m_held=false,m_busy=false;
    std::function<void(const QString&,const rx3::InfoTrack&)> m_jump;
    std::function<void()> m_refresh;
};
