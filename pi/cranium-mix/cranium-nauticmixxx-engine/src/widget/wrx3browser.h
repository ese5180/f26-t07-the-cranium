#pragma once

#include <QLabel>
#include "widget/rx3browsercuestatus.h"
#include <QDir>
#include <QFileInfo>
#include <QDateTime>
#include <QGridLayout>
#include "sources/soundsourceproxy.h"
#include <QHeaderView>
#include <QItemSelectionModel>
#include <QLineEdit>
#include <QListWidget>
#include <QPushButton>
#include <QStackedWidget>
#include <QTableWidget>
#include <QTreeWidget>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QTimer>
#include <QKeyEvent>
#include <QSqlQuery>
#include <QStorageInfo>
#include <QPainter>
#include <QStyledItemDelegate>
#include <QScroller>
#include "library/library.h"
#include "library/rekordbox/rekordboxfeature.h"
#include "library/trackcollectionmanager.h"
#include "library/trackcollection.h"
#include <QPersistentModelIndex>
#include <functional>
#include <memory>
#include <vector>
#include "control/controlobject.h"
#include "library/sidebarmodel.h"
#include "widget/wlibrary.h"
#include "widget/wlibrarysidebar.h"
#include "widget/wmainmenubar.h"
#include "widget/wtracktableview.h"
#include "widget/rx3browsericons.h"
#include "widget/rx3browsernavigation.h"
#include "widget/rx3libraryworkflow.h"
#include "widget/wrx3toolmenu.h"
#include "widget/wrx3utility.h"
#include "widget/wrx3beatfx.h"
#include "widget/rx3touchpreview.h"
#include "widget/rx3browserplayback.h"
#include "preferences/usersettings.h"
#include "widget/wrx3trackinfo.h"
#include "widget/wrx3shortcut.h"
#include "widget/rx3sourceappearance.h"
#include "mixer/playerinfo.h"

class Rx3CategoryDelegate : public QStyledItemDelegate {
  public:
    using QStyledItemDelegate::QStyledItemDelegate;
    void paint(QPainter* p, const QStyleOptionViewItem& option, const QModelIndex& index) const override {
        p->save();
        const bool selected=option.state & QStyle::State_Selected;
        const bool categoryFocus=parent()->property("categoryFocus").toBool();
        p->fillRect(option.rect, QColor(selected ? (categoryFocus ? "#007CE0" : "#777777") : "#202020"));
        if(selected) p->fillRect(QRect(option.rect.topLeft(),QSize(4,option.rect.height())),Qt::white);
        const QString label=index.data().toString().section('\n',1);
        const qreal scale=option.rect.height()/65.0;
        const qreal cx=option.rect.center().x(), cy=option.rect.y()+22*scale;
        rx3::drawBrowserCategoryIcon(p,
                QRectF(cx-16*scale,cy-16*scale,32*scale,32*scale),label,QColor("#bcbcbc"));
        QFont font("Arial");font.setPixelSize(qMax(9,qRound(11*scale)));p->setFont(font);p->setPen(Qt::white);
        p->drawText(option.rect.adjusted(4,qRound(37*scale),-4,-4),Qt::AlignHCenter|Qt::AlignTop,label);
        p->restore();
    }
};

class Rx3SourceTree : public QTreeWidget {
  public:
    using QTreeWidget::QTreeWidget;
  protected:
    void paintEvent(QPaintEvent* event) override {
        QTreeWidget::paintEvent(event);
        QPainter painter(viewport());painter.setPen(QColor("#383838"));
        const int row=topLevelItemCount() ? qMax(1,visualItemRect(topLevelItem(0)).height()) : 84;
        for(int y=row;y<viewport()->height();y+=row) painter.drawLine(0,y,viewport()->width(),y);
    }
};

class Rx3SourceDelegate : public QStyledItemDelegate {
  public:
    using QStyledItemDelegate::QStyledItemDelegate;
    void paint(QPainter* painter,const QStyleOptionViewItem& option,const QModelIndex& index) const override {
        if(index.data(Qt::UserRole).toString().isEmpty()) {
            QStyledItemDelegate::paint(painter,option,index);return;
        }
        painter->save();
        painter->fillRect(option.rect,option.state & QStyle::State_Selected?QColor("#007CE0"):QColor("#1b2026"));
        const int iconWidth=qRound(option.rect.height()*0.9);
        const QRect iconRect(option.rect.left(),option.rect.top(),iconWidth,option.rect.height());
        const int color=index.data(Qt::UserRole+1).toInt();
        painter->fillRect(iconRect,color?rx3::sourceColor(color):
                option.state & QStyle::State_Selected?QColor("#007CE0"):QColor("#1b2026"));
        QFont font("Arial");font.setPixelSize(qMax(12,option.rect.height()/5));painter->setFont(font);painter->setPen(Qt::white);
        const QString slot=index.data(Qt::UserRole+2).toString();
        painter->drawText(iconRect,Qt::AlignCenter,QString("▣\n%1").arg(slot));
        font.setPixelSize(qMax(16,option.rect.height()/3));painter->setFont(font);
        painter->drawText(option.rect.adjusted(iconWidth+16,0,-16,0),Qt::AlignVCenter|Qt::AlignLeft,slot);
        painter->drawText(option.rect.adjusted(iconWidth+16,0,-16,0),Qt::AlignVCenter|Qt::AlignRight,
                index.data(Qt::UserRole+3).toString());
        painter->restore();
    }
};

class Rx3PreviewTable : public QTableWidget {
  public:
    using QTableWidget::QTableWidget;
    void fitRows(int row,int header) {
        horizontalHeader()->setFixedHeight(header);
        verticalHeader()->setMinimumSectionSize(1);
        verticalHeader()->setDefaultSectionSize(row);
        updateGeometries();
    }
};

// A presentation layer over the real library and sidebar models. It keeps
// native loading, search, playlists and USB discovery; no duplicate database.
class WRx3Browser : public QWidget, public WBaseWidget {
    friend struct Rx3BrowserTestAccess;
  public:
    WRx3Browser(WLibrary* library, WLibrarySidebar* sidebar, Library* backend, QWidget* parent, UserSettingsPointer config = {})
            : QWidget(parent), WBaseWidget(this), m_config(std::move(config)), m_library(library), m_backend(backend), m_sidebar(sidebar) {
        setObjectName("RX3NativeBrowser");
        if(qEnvironmentVariableIsSet("CRANIUM_APPLIANCE")) {
            auto colors=palette();colors.setColor(QPalette::Window,Qt::black);setPalette(colors);setAutoFillBackground(true);
        }
        auto* layout = new QVBoxLayout(this);
        layout->setContentsMargins(0,0,0,0); layout->setSpacing(0);
        auto* header = new QWidget(this); header->setObjectName("RX3BrowserHeader");
        m_headerWidget=header;
        auto* headerLayout=new QVBoxLayout(header);headerLayout->setContentsMargins(0,0,0,0);headerLayout->setSpacing(0);
        auto* h = new QHBoxLayout;h->setContentsMargins(0,0,0,0);h->setSpacing(4);headerLayout->addLayout(h);
        m_source = new QPushButton("SOURCE", header); m_source->setObjectName("RX3SourceButton");
        h->addWidget(m_source);
        m_headerButtons.push_back(m_source);
        const auto addHeader=[this,header,h](const QString& text,const QString& name,std::function<void()> action) {
            auto* button=new QPushButton(text,header);button->setObjectName(name);h->addWidget(button);
            m_headerButtons.push_back(button);
            connect(button,&QPushButton::clicked,this,[this,button,action=std::move(action)]{
                if(m_externalNavigation && !(button->objectName()=="RX3BrowserToolsButton" && m_menuHeld) &&
                        toggleExternalNavigation(m_headerButtons.indexOf(button))) return;
                action();
            });return button;
        };
        addHeader("BROWSE","RX3BrowseButton",[this]{browseSelectedSource();});
        addHeader("TAG LIST","RX3TagListButton",[this]{openSourceSection("TAG LIST");});
        addHeader("PLAYLIST","RX3PlaylistButton",[this]{openSourceSection("PLAYLIST");});
        addHeader("SEARCH","RX3SearchButton",[this]{
            if(m_selectedCategory=="SEARCH" && m_pages->currentIndex()==0 && deviceReady(m_selectedDevice)) {m_keyboard->show();m_search->setFocus();}
            else openSearchFromAnywhere();
        });
        auto* menu=addHeader("MENU","RX3BrowserToolsButton",[this]{
            if(m_menuHeld) {m_menuHeld=false;return;}
            if(m_menuHoldTimer) m_menuHoldTimer->stop();
            if(m_pages->currentWidget()==m_utility && !property("craniumFromPerformance").toBool()) closeUtility();
            else showUtility();
        });
        menu->setToolTip("MENU / UTILITY");
        menu->setAccessibleName("MENU / UTILITY");
        m_menuHoldTimer=new QTimer(this);m_menuHoldTimer->setSingleShot(true);m_menuHoldTimer->setInterval(2000);
        connect(menu,&QPushButton::pressed,this,[this]{m_menuHeld=false;m_menuHoldTimer->start();});
        connect(menu,&QPushButton::released,m_menuHoldTimer,&QTimer::stop);
        connect(m_menuHoldTimer,&QTimer::timeout,this,[this]{m_menuHeld=true;showUtility();});
        h->addStretch(1);
        auto* detailRow=new QHBoxLayout;detailRow->setContentsMargins(0,0,0,0);headerLayout->addLayout(detailRow);
        m_sourceLabel=new QLabel(header);m_sourceLabel->setObjectName("RX3BrowserDeviceLabel");m_sourceLabel->hide();detailRow->addWidget(m_sourceLabel);
        m_breadcrumb = new QPushButton("COLLECTION", header);m_breadcrumb->setObjectName("RX3BrowserBreadcrumb");
        m_breadcrumb->setToolTip("Back");m_breadcrumb->setAccessibleName("Go back");detailRow->addWidget(m_breadcrumb, 1);
        connect(m_breadcrumb,&QPushButton::clicked,this,[this]{back();updateNavigationHighlight();});
        m_search = new QLineEdit(header); m_search->setPlaceholderText("SEARCH"); m_search->hide(); detailRow->addWidget(m_search,1);
        m_searchCount=new QLabel("0",header);m_searchCount->setObjectName("RX3SearchCount");m_searchCount->hide();detailRow->addWidget(m_searchCount);
        m_infoButton = new QPushButton("◀  INFO", header);h->addWidget(m_infoButton);m_headerButtons.push_back(m_infoButton);
        layout->addWidget(header);
        m_cueSummary=new QLabel(this);m_cueSummary->setObjectName("CraniumBrowserHotCues");
        m_cueSummary->setTextFormat(Qt::PlainText);
        m_cueSummary->setSizePolicy(QSizePolicy::Ignored,QSizePolicy::Fixed);
        m_cueSummary->setFixedHeight(36);
        m_cueSummary->setStyleSheet("background:#15191d;color:#f4f6f8;font:20px Arial;padding:0 8px;");
        layout->addWidget(m_cueSummary);m_cueSummary->hide();
        m_pages = new QStackedWidget(this); layout->addWidget(m_pages, 1);
        auto* browse = new QWidget(m_pages); auto* b = new QHBoxLayout(browse);
        b->setContentsMargins(0,0,0,0); b->setSpacing(0);
        m_categories = new QListWidget(browse); m_categories->setObjectName("RX3BrowserCategories");
        m_categories->setItemDelegate(new Rx3CategoryDelegate(m_categories));
        m_categories->setFrameShape(QFrame::NoFrame);
        m_categories->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        m_categories->setProperty("categoryFocus",true);
        m_categories->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff); b->addWidget(m_categories);
        m_searchRail=new QListWidget(browse);m_searchRail->setObjectName("RX3BrowserCategories");
        m_searchRail->setFrameShape(QFrame::NoFrame);m_searchRail->setItemDelegate(new Rx3CategoryDelegate(m_searchRail));
        m_searchRail->setProperty("categoryFocus",false);new QListWidgetItem("\nSEARCH",m_searchRail);
        m_searchRail->setCurrentRow(0);m_searchRail->hide();b->addWidget(m_searchRail);
        b->addSpacing(2);
        connect(m_searchRail,&QListWidget::itemClicked,this,[this]{m_keyboard->show();m_search->setFocus();});
        m_sidebar->setParent(browse); m_sidebar->setObjectName("RX3BrowserFolders");
        m_sidebar->setFrameShape(QFrame::NoFrame);
        m_sidebar->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        m_sidebar->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        m_sidebar->setHeaderHidden(true); m_sidebar->setAlternatingRowColors(true);
        m_leftColumn=new QWidget(browse);
        auto* columnLayout=new QHBoxLayout(m_leftColumn);
        columnLayout->setContentsMargins(0,0,0,0);columnLayout->setSpacing(0);
        auto* leftRows=new QWidget(m_leftColumn);
        columnLayout->addWidget(leftRows,1);
        auto* divider=new QWidget(m_leftColumn);
        divider->setObjectName("RX3BrowseColumnDivider");
        divider->setFixedWidth(1);divider->setStyleSheet("background:#777777;");
        columnLayout->addWidget(divider);
        auto* leftLayout=new QVBoxLayout(leftRows);
        leftLayout->setContentsMargins(0,0,0,0);leftLayout->setSpacing(0);
        m_leftHeader=new QLabel("FOLDER",m_leftColumn);m_leftHeader->setObjectName("RX3BrowseColumnHeader");
        leftLayout->addWidget(m_leftHeader);leftLayout->addWidget(m_sidebar,1);
        b->addWidget(m_leftColumn,1);
        m_facets=new QListWidget(m_leftColumn);m_facets->setObjectName("RX3BrowserFacets");
        m_facets->setFrameShape(QFrame::NoFrame);
        m_facets->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        m_facets->setAlternatingRowColors(true);m_facets->hide();leftLayout->addWidget(m_facets,1);
        m_facets->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        connect(m_facets,&QListWidget::currentRowChanged,this,[this]{updateFacetPreview();});
        connect(m_facets,&QListWidget::itemClicked,this,[this](QListWidgetItem*){chooseFacet();});
        m_facets->installEventFilter(this);
        QScroller::grabGesture(m_facets->viewport(),QScroller::TouchGesture);
        QScroller::grabGesture(m_sidebar->viewport(),QScroller::TouchGesture);
        m_loading=new QLabel("Reading USB…",browse);m_loading->setObjectName("RX3BrowserLoading");m_loading->setAlignment(Qt::AlignCenter);m_loading->hide();b->addWidget(m_loading,1);
        m_preview=new QWidget(browse);m_preview->setObjectName("RX3PlaylistPreview");
        auto* previewLayout=new QVBoxLayout(m_preview);
        previewLayout->setContentsMargins(0,0,0,0);previewLayout->setSpacing(0);
        m_previewTracks=new Rx3PreviewTable(m_preview);
        m_previewTracks->setObjectName("RX3PlaylistPreviewTracks");
        m_previewTracks->setColumnCount(1);
        m_previewTracks->setFrameShape(QFrame::NoFrame);
        m_previewTracks->setVerticalScrollMode(QAbstractItemView::ScrollPerItem);
        m_previewTracks->setHorizontalHeaderLabels({"TRACK"});
        m_previewTracks->verticalHeader()->hide();
        m_previewTracks->setShowGrid(false);
        m_previewTracks->setAlternatingRowColors(true);
        m_previewTracks->setEditTriggers(QAbstractItemView::NoEditTriggers);
        m_previewTracks->setSelectionMode(QAbstractItemView::NoSelection);
        m_previewTracks->setFocusPolicy(Qt::NoFocus);
        QScroller::grabGesture(m_previewTracks->viewport(),QScroller::TouchGesture);
        m_previewTracks->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        m_previewTracks->horizontalHeader()->setStretchLastSection(true);
        m_previewTracks->horizontalHeader()->setDefaultAlignment(Qt::AlignLeft|Qt::AlignVCenter);
        previewLayout->addWidget(m_previewTracks,1);
        m_preview->hide();b->addWidget(m_preview,1);
        m_library->setParent(browse); m_library->setObjectName("RX3BrowserTracks"); b->addWidget(m_library, 1);
        m_trackInfo=new QLabel(browse);m_trackInfo->setObjectName("RX3TrackInfo");
        m_trackInfo->setTextFormat(Qt::PlainText);m_trackInfo->setWordWrap(true);
        m_trackInfo->setAlignment(Qt::AlignTop|Qt::AlignLeft);m_trackInfo->hide();b->addWidget(m_trackInfo);
        m_detailedInfo=new Rx3TrackInfoPanel(m_backend?m_backend->rekordboxFeature():nullptr,browse);
        m_detailedInfo->hide();b->addWidget(m_detailedInfo);
        m_detailedInfo->setJump([this](const QString& key,const rx3::InfoTrack& track){
            if(key=="title") ControlObject::set(ConfigKey("[RX3Info]","visible"),0);
            else infoJump(key,track);
        });
        m_detailedInfo->setRefresh([this]{updateTrackInfo();});
        m_emptySpace=new QWidget(browse);b->addWidget(m_emptySpace,1);
        m_pages->addWidget(browse);
        createKeyboard(layout);
        m_pages->installEventFilter(this);
        m_categories->viewport()->installEventFilter(this);
        m_leftColumn->installEventFilter(this);
        m_previewTracks->installEventFilter(this);
        auto* sourcePage = new QWidget(m_pages); auto* sl = new QHBoxLayout(sourcePage);
        sl->setContentsMargins(0,0,0,0); sl->setSpacing(0);
        m_sources = new Rx3SourceTree(sourcePage); m_sources->setObjectName("RX3BrowserSources");
        m_sources->setItemDelegate(new Rx3SourceDelegate(m_sources));
        QScroller::grabGesture(m_sources->viewport(),QScroller::TouchGesture);
        m_sources->setHeaderLabels({"DEVICE NAME"}); m_sources->setRootIsDecorated(false);
        sl->addWidget(m_sources, 3);
        m_info = new QLabel(sourcePage); m_info->setObjectName("RX3SourceInfo"); m_info->setAlignment(Qt::AlignTop | Qt::AlignLeft);
        m_info->setText("INFO");
        auto* sourceInfoPanel=new QWidget(sourcePage);sourceInfoPanel->setObjectName("RX3SourceInfoPanel");
        auto* sourceInfoLayout=new QVBoxLayout(sourceInfoPanel);sourceInfoLayout->setContentsMargins(12,0,12,0);
        sourceInfoLayout->setSpacing(0);
        m_sourceDetails=new QStackedWidget(sourceInfoPanel);sourceInfoLayout->addWidget(m_sourceDetails,3);
        m_sourceDetails->addWidget(m_info);
        m_sourceMenu=new WRx3ToolMenu(m_sourceDetails);m_sourceDetails->addWidget(m_sourceMenu);
        m_sourceMenu->findChild<QListWidget*>("RX3ToolsActions")->setObjectName("RX3SourceSettingsActions");
        m_sourceMenu->findChild<QPushButton*>("RX3ToolsBack")->setObjectName("RX3SourceSettingsBack");
        m_sourceMenu->findChild<QLabel*>("RX3ToolsStatus")->setFixedHeight(64);
        m_sourceMenu->setStyleSheet("#RX3BrowserTools {background:#202020;color:white;} #RX3BrowserTools QLabel {color:white;font-family:Arial;font-size:16px;} #RX3BrowserTools QListWidget {background:#202020;color:white;border:1px solid #aaa;font-family:Arial;font-size:19px;} #RX3BrowserTools QPushButton {background:#202020;color:white;border:1px solid #aaa;min-height:36px;} #RX3SourceSettingsBack[encoderFocus=\"true\"] {background:#007CE0;}");
        m_sourceSettings=new QPushButton("MY SETTINGS MENU",sourceInfoPanel);m_sourceSettings->setObjectName("RX3SourceSettings");
        sourceInfoLayout->addWidget(m_sourceSettings);sourceInfoLayout->addStretch(1);
        connect(m_sourceSettings,&QPushButton::clicked,this,[this]{openSourceSettings();});
        sl->addWidget(sourceInfoPanel, 2); m_pages->addWidget(sourcePage);
        m_tools=new WRx3ToolMenu(m_pages);m_pages->addWidget(m_tools);
        m_utility=new WRx3Utility(m_pages);m_pages->addWidget(m_utility);
        connect(m_pages,&QStackedWidget::currentChanged,this,[this]{updateHeaderHighlight();});
        for(auto* button:m_headerButtons) connect(button,&QPushButton::clicked,this,[this]{updateHeaderHighlight();});
        connect(m_source, &QPushButton::clicked, this, [this]{
            if(m_externalNavigation && toggleExternalNavigation(0)) return;
            showSources();
        });
        connect(m_search, &QLineEdit::textChanged, m_library, [this](const QString& query){
            if(m_selectedCategory=="SEARCH" && deviceReady(m_selectedDevice)) {
                if(query.trimmed().isEmpty()) {
                    m_backend->rekordboxFeature()->showTrackIds(m_currentRoot,{},"search");m_searchHasAllTracks=false;
                } else if(!m_searchHasAllTracks) {
                    m_searchHasAllTracks=true;model()->clicked(m_selectedDevice);
                }
            }
            m_library->search(query);
            QTimer::singleShot(0,this,[this]{refreshTable();updateTrackInfo();}); });
        connect(m_infoButton,&QPushButton::clicked,this,[]{
            ControlObject::set(ConfigKey("[RX3Info]","toggle"),0);
            ControlObject::set(ConfigKey("[RX3Info]","toggle"),1);
            ControlObject::set(ConfigKey("[RX3Info]","toggle"),0);
        });
        connect(m_categories, &QListWidget::itemClicked, this, [this](QListWidgetItem*){ selectCategory(m_categories->currentRow());updateNavigationHighlight(); });
        connect(m_sources,&QTreeWidget::currentItemChanged,this,[this](QTreeWidgetItem* item,QTreeWidgetItem*){updateSourceInfo(m_sources->indexOfTopLevelItem(item));});
        connect(m_sources, &QTreeWidget::itemClicked, this, [this](QTreeWidgetItem*, int){ chooseSource(); });
        connect(m_sidebar, &QTreeView::clicked, this, [this](const QModelIndex& index){
            m_focus=NavigationTarget::Tree;
            // A touchscreen tap enters a playlist/folder. Encoder movement
            // still previews it until the performer presses ENTER.
            enterTree(index);
            updateNavigationHighlight();
        });
        connect(m_library, &QStackedWidget::currentChanged, this, [this](int){ refreshTable(); });
        for (QWidget* w : {static_cast<QWidget*>(m_categories), static_cast<QWidget*>(m_sidebar), static_cast<QWidget*>(m_sources)}) w->installEventFilter(this);
        makeControl("enabled", [](double){}, true)->set(1);
        makeControl("move", [this](double value){ if(value != 0) {move(qRound(value));updateNavigationHighlight();} });
        makeControl("enter", [this](double value){ if(value > 0) {
            if (!isVisible()) openBrowser();
            else {enter();updateNavigationHighlight();}
        } });
        makeControl("back", [this](double value){ if(value > 0) {back();updateNavigationHighlight();} });
        makeControl("source", [this](double value){ if(value > 0) {
            showBrowser();
            showSources();
        } });
        makeControl("open", [this](double value){ if(value > 0) openBrowser(); });
        makeControl("tools",[this](double value){if(value>0) showTools();});
        makeControl("utility",[this](double value){if(value>0) {if(m_pages->currentWidget()==m_utility) closeUtility();else showUtility();}});
        makeControl("browse",[this](double value){if(value>0) browseSelectedSource();});
        makeControl("tag_list",[this](double value){if(value>0) openSourceSection("TAG LIST");});
        makeControl("playlist",[this](double value){if(value>0) openSourceSection("PLAYLIST");});
        makeControl("search",[this](double value){if(value>0) openSearchFromAnywhere();});
        makeControl("my_settings",[this](double value){if(value>0) {showBrowser();showSources();openSourceSettings();}});
        for(const auto& name:{"play_mode","eject_lock"}) {
            const auto key=ConfigKey("[RX3Settings]",name);
            if(!ControlObject::exists(key)) {
                const auto initial=m_config?m_config->getValue<double>(key,1):1;
                m_controls.push_back(std::make_unique<ControlObject>(key,false,false,false,initial));
            }
        }

        for(int deck=1;deck<=2;++deck) {
            const auto group=QString("[Channel%1]").arg(deck);
            if(ControlObject::exists(ConfigKey(group,"rx3_track_end"))) {
                auto* ended=new ControlProxy(group,"rx3_track_end",this);
                ended->connectValueChanged(this,[this,deck](double value){if(value>0) advanceContinuous(deck);});
            }
        }
        for(const auto& count:QList<QPair<QString,int>>{{"num_microphones",2},{"num_auxiliaries",1}})
            if(ControlObject::exists(ConfigKey("[App]",count.first)) && ControlObject::get(ConfigKey("[App]",count.first))<count.second)
                ControlObject::set(ConfigKey("[App]",count.first),count.second);
        auto* workflowTimer=new QTimer(this);workflowTimer->setInterval(1000);
        connect(workflowTimer,&QTimer::timeout,this,[this]{refreshSessionWork();});workflowTimer->start();
        QTimer::singleShot(0, this, [this]{ showSources(); refreshTable(); });
        connect(m_sidebar->model(), &QAbstractItemModel::rowsInserted, this, [this]{ onDeviceModelChanged(); });
        connect(m_sidebar->model(), &QAbstractItemModel::rowsRemoved, this, [this]{ onDeviceModelChanged(); });
        connect(m_sidebar->model(), &QAbstractItemModel::dataChanged, this, [this]{ onDeviceModelChanged(); });
        connect(m_sidebar->model(), &QAbstractItemModel::modelReset, this, [this]{onDeviceModelChanged();});
        connect(&PlayerInfo::instance(),&PlayerInfo::trackChanged,this,[this](const QString& group,TrackPointer track,TrackPointer){
            const bool continued=track && m_continuousLoads.remove(group+track->getLocation());
            if(!track) m_playbackOrigins.remove(group);
            else if(!continued && m_level==BrowserLevel::Tracks) {
                rememberOrigin(track->getLocation());
                const auto origin=m_origins.constFind(track->getLocation());
                if(origin!=m_origins.cend()) m_playbackOrigins.insert(group,*origin);
                else m_playbackOrigins.remove(group);
            }
            if(m_selectedCategory=="MATCHING") updateFacetPreview();
        });
    }
    ~WRx3Browser() override = default;
    // Move the real native controls into the skin's always-visible toolbar.
    // Reusing them preserves controller focus, enabled states and MENU hold.
    void attachExternalNavigation(QWidget* host) {
        if(!host || !host->layout() || m_externalNavigation) return;
        m_externalNavigation=true;
        for(auto* button:m_headerButtons) {
            host->layout()->addWidget(button);
            button->setMinimumWidth(0);button->setMaximumWidth(QWIDGETSIZE_MAX);
            button->setSizePolicy(QSizePolicy::Expanding,QSizePolicy::Fixed);
            button->setFixedHeight(60);button->show();
        }
        auto* page=new ControlProxy("[Tab]","current",host,ControlFlag::NoAssertIfMissing);
        page->connectValueChanged(this,[this](double value){
            if(value!=1) {m_externalAction=-1;m_keyboard->hide();}
            updateHeaderHighlight();
        });
        m_infoButton->setText("INFO");
        m_headerWidget->setFixedHeight(48);
        updateHeaderHighlight();
    }
    QString infoUsbName(const QString& root) const {return QString("USB%1").arg(m_usbSlots.value(root));}
    Rx3TrackInfoPanel* detailedInfo() const {return m_detailedInfo;}
    bool canShowInfo() const {return m_pages->currentIndex()==0 && m_level==BrowserLevel::Tracks;}
    void showTrackInfo(bool show) {
        m_detailedInfo->setVisible(show && canShowInfo());
        m_infoButton->setStyleSheet(show?"color:#007CE0;":"");
        if(show) {m_trackInfo->hide();updateTrackInfo();}
    }
    void infoJump(const QString& key,const rx3::InfoTrack& track) {
        if(!m_backend) return;
        ControlObject::set(ConfigKey("[RX3Info]","visible"),0);showBrowser();
        if(key=="title" && m_origins.contains(track.location)) {
            const auto origin=m_origins.value(track.location);
            if(!selectInfoRoot(origin.root)) {showSources();return;}
            m_selectedCategory=origin.category;m_sidebar->setRootIndex(origin.treeRoot);
            if(origin.treeSelection.isValid()) m_sidebar->selectIndex(origin.treeSelection);
            m_categories->setCurrentRow(origin.categoryRow);
            m_facetTracks=origin.facets;m_facetField=origin.field;m_folderPath=origin.folder;
            m_facets->clear();m_facets->addItems(origin.facetLabels);
            m_facets->setCurrentRow(origin.facetRow);
            if(origin.field=="folder") m_backend->showUsbFolder(origin.root,origin.folder);
            else m_backend->rekordboxFeature()->showTrackIds(origin.root,origin.ids,"info-return");
            showTrackList(origin.returnLevel);m_breadcrumb->setText(origin.breadcrumb);
            m_pendingFolderTrack=track.location;selectPendingFolderTrack();return;
        }
        if(track.root.isEmpty()) {openBrowser();return;}
        if(!selectInfoRoot(track.root)) {showSources();return;}
        if(key=="title") {
            auto* feature=m_backend->rekordboxFeature();
            feature->showTrackIds(track.root,catalog()->tracks().keys(),"info-return");
            showTrackList(BrowserLevel::Categories);m_breadcrumb->setText("TRACK");
            m_pendingFolderTrack=track.location;selectPendingFolderTrack();return;
        }
        if(!track.canJump()) return;
        const auto field=key=="color"?QString("color_id"):key;
        m_selectedCategory=key.toUpper();showFacet(field);
        for(int row=0;row<m_facets->count();++row) if(m_facetTracks.value(m_facets->item(row)->text()).contains(track.record->rekordboxId)) {
            m_facets->setCurrentRow(row);chooseFacet();return;
        }
    }
  protected:
    void hideEvent(QHideEvent* event) override {
        if(m_toolPreview) m_toolPreview->cancel();
        m_resumeFocus=m_focus;
        QWidget::hideEvent(event);
    }
    void resizeEvent(QResizeEvent* event) override {
        QWidget::resizeEvent(event);
        const double scale = qMax(0.6, height()/690.0);
        m_categories->setFixedWidth(qRound(96*scale));
        m_searchRail->setFixedWidth(qRound(96*scale));m_searchRail->item(0)->setSizeHint(QSize(qRound(96*scale),qRound(65*scale)));
        m_headerWidget->setFixedHeight(qRound((m_externalNavigation?48:78)*scale));
        for(auto* button:m_headerButtons) button->setFixedHeight(qRound((m_externalNavigation?60:46)*scale));
        if(!m_externalNavigation) m_source->setFixedWidth(qRound(100*scale));
        const int detailHeight=qRound((m_externalNavigation?48:32)*scale);
        m_breadcrumb->setFixedHeight(detailHeight);m_sourceLabel->setFixedHeight(detailHeight);
        m_cueSummary->setFixedHeight(qRound(36*scale));
        m_search->setMaximumWidth(m_selectedCategory=="SEARCH" ? QWIDGETSIZE_MAX : qRound(400*scale));
        m_trackInfo->setFixedWidth(qRound(280*scale));
        m_detailedInfo->setFixedWidth(qRound(560*scale));
        m_keyboard->setFixedHeight(qRound(215*scale));
        QTimer::singleShot(0,this,[this]{fitBrowseRows();});
        refreshTable();
    }
    bool eventFilter(QObject* watched, QEvent* event) override {
        if(event->type()==QEvent::Resize && (watched==m_pages || watched==m_leftColumn || watched==m_previewTracks))
            QTimer::singleShot(0,this,[this]{fitBrowseRows();});

        if(event->type() == QEvent::FocusIn || event->type() == QEvent::MouseButtonPress) {
            if(watched==m_categories || watched==m_categories->viewport()) m_focus=NavigationTarget::Categories;
            else if(watched==m_sidebar) m_focus=NavigationTarget::Tree;
            else if(watched==m_sources) m_focus=NavigationTarget::Source;
            else if(watched==m_facets) m_focus=NavigationTarget::Facets;
            else m_focus=NavigationTarget::TrackList;
        }
        if(event->type() == QEvent::KeyPress) {
            auto* key = static_cast<QKeyEvent*>(event);
            if(watched==m_categories && (key->key()==Qt::Key_Up || key->key()==Qt::Key_Down)) {
                move(key->key()==Qt::Key_Up ? -1 : 1);updateNavigationHighlight();return true;
            }
            if (key->key()==Qt::Key_Return || key->key()==Qt::Key_Enter) { enter(); return true; }
            if (key->key()==Qt::Key_Left || key->key()==Qt::Key_Escape) { back(); return true; }
            if(watched==m_sidebar && (key->key()==Qt::Key_Up || key->key()==Qt::Key_Down ||
                    key->key()==Qt::Key_Home || key->key()==Qt::Key_End ||
                    key->key()==Qt::Key_PageUp || key->key()==Qt::Key_PageDown)) {
                QTimer::singleShot(0,this,[this]{updatePlaylistPreview();});
            }
        }
        if(event->type()==QEvent::FocusIn || event->type()==QEvent::MouseButtonPress)
            updateNavigationHighlight();
        return QWidget::eventFilter(watched,event);
    }
  private:
    enum class NavigationTarget {
        Categories,
        Tree,
        TrackList,
        Source,
        Facets,
    };
    enum class BrowserLevel { Categories, Hierarchy, FacetValues, Tracks, Notice };

    int selectedHeaderAction() const {
        int selected=1;
        if(m_pages->currentWidget()==m_tools || m_pages->currentWidget()==m_utility) selected=5;
        else if(m_pages->currentIndex()==1) selected=0;
        else if(m_selectedCategory=="TAG LIST") selected=2;
        else if(m_selectedCategory=="PLAYLIST") selected=3;
        else if(m_selectedCategory=="SEARCH") selected=4;
        return selected;
    }
    bool toggleExternalNavigation(int action) {
        const bool fromPerformance=ControlObject::get(ConfigKey("[Tab]","current"))!=1;
        setProperty("craniumFromPerformance",fromPerformance);
        const int active=m_externalAction>=0?m_externalAction:selectedHeaderAction();
        if(!fromPerformance && active==action) {
            ControlObject::set(ConfigKey("[Tab]","current"),0);
            return true;
        }
        showBrowser();
        m_externalAction=action;
        updateHeaderHighlight();
        return false;
    }
    void updateHeaderHighlight() {
        const int selected=m_externalNavigation && m_externalAction>=0?m_externalAction:selectedHeaderAction();
        const bool showActive=!m_externalNavigation || ControlObject::get(ConfigKey("[Tab]","current"))==1;
        for(int i=0;i<m_headerButtons.size();++i) {
            auto* button=m_headerButtons[i];button->setProperty("active",showActive && i==selected);
            button->style()->unpolish(button);button->style()->polish(button);button->update();
        }
    }
    void updateNavigationHighlight() {
        updateHeaderHighlight();
        const bool categories=m_focus==NavigationTarget::Categories;
        m_categories->setProperty("categoryFocus",categories);
        m_categories->viewport()->update();
        const QString selection=categories ? "#777777" : "#007CE0";
        m_sidebar->setStyleSheet(QString("#RX3BrowserFolders::item {height:%1px;} #RX3BrowserFolders::item:selected {background:%2;color:#fff;}").arg(m_browseRowHeight).arg(selection));
        m_facets->setStyleSheet(QString("#RX3BrowserFacets::item:selected {background:%1;color:#fff;}").arg(selection));
    }
    void fitBrowseRows() {
        layout()->activate();
        if(auto* page=m_pages->currentWidget()) if(page->layout()) page->layout()->activate();
        m_leftColumn->layout()->activate();m_preview->layout()->activate();
        const int categoryHeight=m_categories->viewport()->height();
        const int count=m_categories->count();
        for(int i=0;i<count;++i)
            m_categories->item(i)->setSizeHint(QSize(m_categories->viewport()->width(),
                    categoryHeight/count+(i<categoryHeight%count ? 1 : 0)));
        m_categories->doItemsLayout();
        const int available=m_previewTracks->height()-2*m_previewTracks->frameWidth();
        const auto geometry=rx3::twelveBrowserRows(available);
        const int row=geometry.rowHeight,header=geometry.headerHeight;
        m_leftHeader->setFixedHeight(header);
        if(m_browseRowHeight!=row) {m_browseRowHeight=row;updateNavigationHighlight();}
        for(int i=0;i<m_facets->count();++i) m_facets->item(i)->setSizeHint(QSize(1,row));
        m_previewTracks->fitRows(row,header);
        m_facets->setVerticalScrollMode(QAbstractItemView::ScrollPerItem);
        m_sidebar->setVerticalScrollMode(QAbstractItemView::ScrollPerItem);
        m_facets->doItemsLayout();
    }
    void createKeyboard(QVBoxLayout* layout) {
        m_keyboard=new QWidget(this);m_keyboard->setObjectName("RX3SearchKeyboard");
        auto* keys=new QGridLayout(m_keyboard);keys->setContentsMargins(10,8,10,8);keys->setSpacing(6);
        auto add=[this,keys](const QString& text,int row,int col,int span=1) {
            auto* button=new QPushButton(text,m_keyboard);button->setFocusPolicy(Qt::NoFocus);
            button->setSizePolicy(QSizePolicy::Expanding,QSizePolicy::Expanding);
            keys->addWidget(button,row,col,1,span);
            connect(button,&QPushButton::clicked,this,[this,text]{
                if(text=="⌫") m_search->backspace();
                else if(text=="CLEAR") m_search->clear();
                else if(text=="SPACE") m_search->insert(" ");
                else if(text=="123" || text=="ABC") {
                    m_numericKeyboard=!m_numericKeyboard;
                    const QStringList rows=m_numericKeyboard ? QStringList{"1234567890","@#&()_-+",",.!?/:"}
                            : QStringList{"QWERTYUIOP","ASDFGHJKL","ZXCVBNM"};
                    const auto buttons=m_keyboard->findChildren<QPushButton*>();
                    for(auto* key:buttons) {
                        const int r=key->property("keyRow").toInt(),c=key->property("keyCol").toInt();
                        if(key->property("characterKey").toBool()) {
                            key->setText(c<rows[r].size() ? QString(rows[r][c]) : QString());
                            key->setEnabled(c<rows[r].size());
                        }
                    }
                    m_keyboardToggle->setText(m_numericKeyboard ? "ABC" : "123");
                } else {
                    auto* key=qobject_cast<QPushButton*>(sender());
                    m_search->insert(key ? key->text() : text);
                }
                m_search->setFocus();
            });
            return button;
        };
        const QStringList rows={"QWERTYUIOP","ASDFGHJKL","ZXCVBNM"};
        for(int r=0;r<3;++r) for(int c=0;c<rows[r].size();++c) {
            auto* key=add(QString(rows[r][c]),r,c+(r==2 ? 2 : r));
            key->setProperty("characterKey",true);key->setProperty("keyRow",r);key->setProperty("keyCol",c);
        }
        add("⌫",0,11,2);add("CLEAR",1,11,2);add("SPACE",2,11,2);
        m_keyboardToggle=add("123",2,0,2);
        layout->addWidget(m_keyboard);m_keyboard->hide();
    }
    void openSearchFromAnywhere() {
        showBrowser();
        if(!deviceReady(sourceDeviceForNavigation())) {
            // Search may be the first action after boot or after visiting MENU.
            // Keep the selected source when valid, otherwise use the first ready USB.
            for(const auto& device:m_devices) if(deviceReady(device)) {
                selectInfoRoot(deviceRoot(device));
                break;
            }
        }
        if(prepareSourceNavigation()) openSearch();
    }
    void openSearch() {
        if(!deviceReady(m_selectedDevice)) {showSources();return;}
        m_pages->setCurrentIndex(0);
        m_utilitySessionActive=false;
        m_selectedCategory="SEARCH";m_search->clear();
        m_searchHasAllTracks=false;
        m_backend->rekordboxFeature()->showTrackIds(m_currentRoot,{},"search");showTrackList(BrowserLevel::Categories);
        m_categories->hide();m_searchRail->show();m_search->show();m_search->setMaximumWidth(QWIDGETSIZE_MAX);
        m_breadcrumb->hide();m_searchCount->show();m_keyboard->show();
        m_breadcrumb->setText("⌕");m_trackInfo->show();updateTrackInfo();
        m_search->setFocus();
    }
    void setPreview(const QString& header,const QStringList& rows) {
        m_previewTracks->clearContents();m_previewTracks->setHorizontalHeaderLabels({header});
        m_previewTracks->setRowCount(qMax(12,rows.size()));
        for(int i=0;i<rows.size();++i) m_previewTracks->setItem(i,0,new QTableWidgetItem(rows[i]));
        m_previewTracks->show();m_preview->show();
        QTimer::singleShot(0,this,[this]{fitBrowseRows();});
    }
    ControlObject* makeControl(const QString& name, std::function<void(double)> handler, bool ignoreNops=false) {
        auto control = std::make_unique<ControlObject>(ConfigKey("[RX3Browser]", name), ignoreNops);
        auto* ptr = control.get();
        connect(ptr, &ControlObject::valueChanged, this, [this,handler](double value){
            m_externalAction=-1;handler(value);
        });
        m_controls.push_back(std::move(control)); return ptr;
    }
    static void showBrowser() {
        // The RX3 skin's page 1 is the browser. Navigation controls own only
        // presentation state and never load, import or persist a track.
        ControlObject::set(ConfigKey(QStringLiteral("[Tab]"),
                                   QStringLiteral("current")),
                1.0);
    }
    void openBrowser() {
        showBrowser();
        m_keyboard->hide();
        if(m_pages->currentIndex()==1 && deviceReady(sourceDeviceForNavigation())) {chooseSource();return;}
        // Showing the tab may make Qt restore focus to the folder tree.
        // Restore our saved logical navigation target after that completes.
        const auto resume=m_resumeFocus;
        m_focus=resume;
        QTimer::singleShot(0,this,[this,resume]{restoreNavigationFocus(resume);});
    }
    SidebarModel* model() const { return qobject_cast<SidebarModel*>(m_sidebar->model()); }
    std::shared_ptr<const mixxx::rekordbox::RuntimeCatalog> catalog() const {
        auto* feature = m_backend?m_backend->rekordboxFeature():nullptr;
        return feature ? feature->catalogForRoot(m_currentRoot) : nullptr;
    }
    void populateCategories() {
        const auto previous = m_categories->currentRow() >= 0 &&
                m_categories->currentRow() < m_categoryIds.size()
                ? m_categoryIds.at(m_categories->currentRow()) : quint16(0);
        m_categories->clear();m_categoryIds.clear();
        if(!m_selectedDevice.isValid()) {showSources();return;}
        const auto currentCatalog=catalog();
        if(deviceStatus(m_selectedDevice)!="ready" || !currentCatalog) return;
        const auto menu=currentCatalog->browseMenu();
        int selected = 0;
        auto categories=menu.categories;
        std::stable_sort(categories.begin(),categories.end(),[](const auto& a,const auto& b){
            return rx3::categoryRank(a.label)<rx3::categoryRank(b.label);
        });
        for(const auto& category : categories) {
            const auto label = category.label.toUpper();
            auto* item=new QListWidgetItem("\n" + label,m_categories);
            item->setTextAlignment(Qt::AlignCenter);item->setSizeHint(QSize(94,65));
            if(category.id == previous) selected=m_categoryIds.size();
            m_categoryIds.append(category.id);
        }
        if(!m_categoryIds.isEmpty()) m_categories->setCurrentRow(selected);
        m_level=BrowserLevel::Categories;
    }
    QModelIndex selectedTreeIndex() const {
        if(auto* selection=m_sidebar->selectionModel()) {
            const auto rows=selection->selectedRows();
            if(!rows.isEmpty()) return rows.first();
        }
        return m_sidebar->currentIndex();
    }
    void updatePlaylistPreview() {
        if(m_level!=BrowserLevel::Hierarchy || !m_preview->isVisible()) return;
        const auto currentCatalog=catalog();
        const QModelIndex index=selectedTreeIndex();
        const auto data=index.data(SidebarModel::DataRole).toList();
        std::optional<mixxx::rekordbox::RuntimePlaylistNode> playlist;
        if(currentCatalog && data.size()>=3)
            playlist=currentCatalog->findPlaylist(static_cast<quint32>(data[2].toULongLong()));
        if(!playlist) {setPreview("TRACK",{});return;}
        QStringList rows;
        if(playlist->isFolder) {
            for(const auto& child:playlist->children) rows.append(child.name);
        } else {
            const auto tracks=currentCatalog->tracks();
            for(const auto id:playlist->trackIds) rows.append(tracks.value(id).title);
        }
        setPreview(playlist->isFolder ? "FOLDER" : "TRACK",rows);
    }
    void updateFacetPreview() {
        if(m_level!=BrowserLevel::FacetValues || !m_facets->currentItem()) return;
        const auto value=m_facets->currentItem()->text();
        if(m_facetField=="folder") {
            QStringList rows;
            for(const auto& entry:folderEntries(m_folderPaths.value(value))) rows.append(entry.fileName());
            setPreview("FOLDER",rows);return;
        }
        if(m_facetField=="key") {
            const auto current=catalog();QStringList rows;
            if(current) {rx3::TrackFilter filter;filter.referenceKey=value;filter.keyMode=1;
                const auto tracks=current->tracks();
                for(auto id:filter.apply(tracks)) if(!rows.contains(tracks.value(id).key)) rows.append(tracks.value(id).key);
            }
            setPreview("RELATED KEY",rows);return;
        }
        if(m_facetField=="matching") {
            const auto currentCatalog=catalog();
            const auto reference=PlayerInfo::instance().getTrackInfo(
                    QString("[Channel%1]").arg(m_facets->currentRow()+1));
            QList<quint32> ids;
            if(currentCatalog && reference && reference->isSourceAvailableForPlayback())
                ids=rx3::matchingTrackIds(currentCatalog->tracks(),reference->getLocation(),
                        reference->getKeyText(),reference->getBpm());
            m_facetTracks.insert(value,ids);
        }
        const auto currentCatalog=catalog();
        QStringList rows;
        if(currentCatalog) {
            const auto tracks=currentCatalog->tracks();
            for(const auto id:m_facetTracks.value(value)) {
                const auto track=tracks.constFind(id);
                if(track==tracks.cend()) continue;
                const auto text=m_facetField=="artist" ? track->album : track->title;
                if(!text.isEmpty() && (m_facetField!="artist" || !rows.contains(text))) rows.append(text);
            }
        }
        setPreview(m_facetField=="artist" ? "ALBUM" : "TRACK",rows);
    }
    void selectPendingFolderTrack() {
        if(m_pendingFolderTrack.isEmpty()) return;
        if(auto* table=m_library->getCurrentTrackTableView()) {
            auto* tracks=dynamic_cast<TrackModel*>(table->model());
            if(!tracks) return;
            for(int row=0;row<table->model()->rowCount();++row) {
                if(tracks->getTrackLocation(table->model()->index(row,0))!=m_pendingFolderTrack) continue;
                table->selectRow(row);m_pendingFolderTrack.clear();return;
            }
        }
    }
    void refreshTable() {
        if(auto* table=m_library->getCurrentTrackTableView()) {
            table->setRx3Browser(true);table->viewport()->installEventFilter(this);
            if(!table->viewport()->property("rx3TouchScroll").toBool()) {
                table->viewport()->setProperty("rx3TouchScroll",true);
                QScroller::grabGesture(table->viewport(),QScroller::TouchGesture);
            }
            table->setRx3ExpandedTracks(m_level==BrowserLevel::Tracks);
            table->setRx3SearchTracks(m_selectedCategory=="SEARCH");
            if(!table->property("rx3ModelConnected").toBool()) {
                table->setProperty("rx3ModelConnected",true);
                connect(table,&WTrackTableView::rx3ModelChanged,this,[this]{
                    if(m_level==BrowserLevel::Tracks) {
                        m_loading->hide();m_library->show();m_emptySpace->hide();
                    }
                    refreshTable();updateTrackInfo();
                });
            }
            // Skin creation can expose the table before its first model is assigned.
            if(auto* rows=table->model();rows && !rows->property("rx3RowsConnected").toBool()) {
                rows->setProperty("rx3RowsConnected",true);
                connect(rows,&QAbstractItemModel::rowsInserted,this,[this]{selectPendingFolderTrack();updateTrackInfo();});
            }
            if(auto* selection=table->selectionModel();selection && !selection->property("rx3SelectionConnected").toBool()) {
                selection->setProperty("rx3SelectionConnected",true);
                connect(selection,&QItemSelectionModel::currentRowChanged,this,[this]{updateTrackInfo();});
            }
        }
    }
    bool selectInfoRoot(const QString& root) {
        if(!m_backend || !m_backend->rekordboxFeature()->catalogForRoot(root)) return false;
        for(const auto& device:m_devices) if(deviceRoot(device)==root) {m_selectedDevice=device;break;}
        m_currentRoot=root;
        m_pages->setCurrentIndex(0);populateCategories();
        m_source->setText("SOURCE");updateSourceAppearance();
        return true;
    }
    void rememberOrigin(const QString& location) {
        if(!m_backend || location.isEmpty()) return;
        const auto current=catalog();if(!current) return;
        const auto tracks=current->tracks();
        QHash<QString,quint32> ids;for(const auto& track:tracks) ids.insert(track.resolvedAudioPath,track.rekordboxId);
        InfoOrigin origin;origin.root=m_currentRoot;origin.category=m_selectedCategory;
        origin.breadcrumb=m_breadcrumb->text();origin.treeRoot=m_sidebar->rootIndex();
        origin.treeSelection=selectedTreeIndex();origin.categoryRow=m_categories->currentRow();
        for(int row=0;row<m_facets->count();++row) origin.facetLabels.append(m_facets->item(row)->text());
        origin.facets=m_facetTracks;origin.field=m_facetField;origin.folder=m_folderPath;
        origin.facetRow=m_facets->currentRow();origin.returnLevel=m_returnLevel;
        if(auto* table=m_library->getCurrentTrackTableView()) if(auto* model=dynamic_cast<TrackModel*>(table->model()))
            for(int row=0;row<table->model()->rowCount();++row) {
                const auto id=ids.value(model->getTrackLocation(table->model()->index(row,0)));
                if(id) origin.ids.append(id);
            }
        if(ids.contains(location)) m_origins.insert(location,origin);
    }
    void updateTrackInfo() {
        m_cueSummary->hide();
        if(m_level==BrowserLevel::Tracks && m_pages->currentIndex()==0 && m_backend) {
            if(auto* table=m_library->getCurrentTrackTableView();table && table->model()) {
                if(auto* tracks=dynamic_cast<TrackModel*>(table->model())) {
                    const auto record=m_backend->rekordboxFeature()->infoForLocation(
                            tracks->getTrackLocation(table->currentIndex()),nullptr);
                    if(record) {m_cueSummary->setText(rx3::exportedHotCueSummary(record->cues));m_cueSummary->show();}
                }
            }
        }
        if(m_selectedCategory=="SEARCH") {
            const auto* table=m_library->getCurrentTrackTableView();
            m_searchCount->setText(QString::number(table && table->model() ? table->model()->rowCount() : 0));
        }
        if(m_detailedInfo->isVisible()) {
            rx3::InfoTrack details;
            if(auto* table=m_library->getCurrentTrackTableView();table && table->model()) {
                if(auto* tracks=dynamic_cast<TrackModel*>(table->model())) {
                    details=rx3::infoTrack(m_backend?m_backend->rekordboxFeature():nullptr,tracks->getTrackLocation(table->currentIndex()));
                    details.total=table->model()->rowCount();details.number=table->currentIndex().row()+1;
                    if(!details.record) {
                        const QStringList keys={"title","artist","album","duration","bpm","key","rating","color","genre","date_added"};
                        for(int col=0;col<table->model()->columnCount();++col) {
                            const auto name=table->model()->headerData(col,Qt::Horizontal,TrackModel::kHeaderNameRole).toString();
                            const int field=keys.indexOf(name);
                            if(field>=0) details.values[field]=table->model()->index(table->currentIndex().row(),col).data().toString();
                        }
                    }
                }
            }
            m_detailedInfo->setTrack(details);
        }
        if(!m_trackInfo->isVisible()) return;
        QString text="INFO";
        if(auto* table=m_library->getCurrentTrackTableView();table && table->model()) {
            const int row=table->currentIndex().row();
            if(row>=0) for(int col=0;col<table->model()->columnCount();++col) {
                const QString name=table->model()->headerData(col,Qt::Horizontal,TrackModel::kHeaderNameRole).toString();
                if(QStringList{"title","artist","album","genre","bpm","key"}.contains(name))
                    text+="\n\n"+name.toUpper()+"\n"+table->model()->index(row,col).data().toString();
            }
        }
        m_trackInfo->setText(text);
    }
    void activate(const QModelIndex& index) {
        if(!index.isValid()) return;
        m_sidebar->selectIndex(index);
        model()->clicked(index);
        m_breadcrumb->setText(index.data(SidebarModel::IconNameRole).toString() == "tracks" ? "COLLECTION / TRACK" : index.data().toString());
        QTimer::singleShot(0,this,[this]{refreshTable();});
    }
    void showNotice(const QString& message) {
        m_cueSummary->hide();
        m_leftColumn->hide();
        m_level=BrowserLevel::Notice;m_sidebar->hide();m_facets->hide();m_library->hide();
        m_trackInfo->hide();
        m_preview->hide();m_emptySpace->hide();m_loading->setText(message);m_loading->show();m_focus=NavigationTarget::Categories;
        refreshTable();
    }
    void showComingSoon(const QString& category) {
        showNotice(QString());
        m_loading->setText(QStringLiteral(
                "<div style='text-align:center'>"
                "<p style='color:#00b8d4;font-size:13px;font-weight:600'>CRANIUM</p>"
                "<p style='color:#ffffff;font-size:27px;font-weight:700'>%1</p>"
                "<p style='color:#b8c1c7;font-size:16px'>COMING SOON</p>"
                "<p style='color:#849199;font-size:12px'>Available in a future release</p>"
                "</div>").arg(category.toHtmlEscaped()));
    }
    void showTrackList(BrowserLevel returnLevel) {
        m_pages->setCurrentIndex(0);
        m_leftColumn->hide();
        m_returnLevel=returnLevel;m_level=BrowserLevel::Tracks;
        m_sidebar->hide();m_facets->hide();m_preview->hide();m_loading->hide();m_library->show();
        m_emptySpace->hide();
        refreshTable();focusTracks();
        updateTrackInfo();
    }
    void selectCategory(int row) {
        m_cueSummary->hide();
        if(m_detailedInfo->isVisible()) ControlObject::set(ConfigKey("[RX3Info]","visible"),0);
        if(row<0 || row>=m_categoryIds.size() || !m_selectedDevice.isValid()) return;
        if(deviceStatus(m_selectedDevice)!="ready" || !catalog()) {
            showSources();
            return;
        }
        const auto label=m_categories->item(row)->text().section('\n',1).toUpper();
        if(label!="SEARCH") m_searchReturnCategory=row;
        m_selectedCategory=label;m_pendingFolderTrack.clear();m_search->clear();m_library->search(QString());
        m_keyboard->hide();m_search->hide();m_categories->show();m_searchRail->hide();m_breadcrumb->show();m_searchCount->hide();
        m_leftColumn->show();
        m_trackInfo->hide();
        m_pages->setCurrentIndex(0);m_loading->hide();
        if(label=="TRACK" || label=="TRACKS" || label=="SEARCH") {
            model()->clicked(m_selectedDevice);
            showTrackList(BrowserLevel::Categories);
            m_breadcrumb->setText(label);
            if(label=="SEARCH") openSearch();
            return;
        }
        if(label=="PLAYLIST") {
            m_level=BrowserLevel::Hierarchy;
            m_facets->hide();m_library->hide();m_sidebar->setRootIndex(m_selectedDevice);
            m_emptySpace->hide();m_preview->show();
            m_sidebar->show();m_leftHeader->setText("FOLDER");m_breadcrumb->setText(label);
            m_focus=NavigationTarget::Tree;
            m_sidebar->setFocus();
            if(model()->rowCount(m_selectedDevice)>0)
                m_sidebar->selectIndex(model()->index(0,0,m_selectedDevice));
            updatePlaylistPreview();refreshTable();
            QTimer::singleShot(0,this,[this]{fitBrowseRows();});return;
        }
        if(label=="HISTORY") {showHistory();return;}
        if(label=="FOLDER") {showFolder(m_currentRoot);return;}
        if(label=="MATCHING") {showMatching();return;}
        if(label=="REC") {showUtility();openUtilityTools("USB RECORDING",[this]{showRecordingTools();});return;}
        const QHash<QString,QString> fields={{"ARTIST","artist"},{"ALBUM","album"},
                {"ALBUMS","album"},{"GENRE","genre"},{"KEY","key"},
                {"BPM","bpm"},{"RATING","rating"},{"YEAR","year"},
                {"LABEL","label"},{"REMIXER","remixer"},{"COLOR","color_id"},
                {"DATE ADDED","date_added"}};
        if(fields.contains(label)) {showFacet(fields.value(label));return;}
        showComingSoon(label);
    }
    QString facetValue(const mixxx::rekordbox::RuntimeTrack& track,
            const QString& field) const {
        if(field=="artist") return track.artist;
        if(field=="album") return track.album;
        if(field=="genre") return track.genre;
        if(field=="key") return track.key;
        if(field=="bpm") return track.bpm ? QString::number(*track.bpm,'f',1) : QString();
        if(field=="rating") return track.rating ? QString::number(*track.rating) : QString();
        return track.rawMetadata.value(field).toVariant().toString();
    }
    void showFacet(const QString& field) {
        m_facetField=field;m_facetTracks.clear();m_facets->clear();
        const auto currentCatalog=catalog();
        if(!currentCatalog) {showNotice("USB unavailable.");return;}
        const auto tracks=currentCatalog->tracks();
        auto ids=tracks.keys();std::sort(ids.begin(),ids.end());
        const QHash<QString,QString> identityFields={{"artist","artist_id"},
                {"album","album_id"},{"genre","genre_id"},{"key","key_id"},
                {"label","label_id"},{"remixer","remixer_id"}};
        QMap<QString,QList<quint32>> groups;
        QMap<QString,QString> labels;
        QMap<QString,int> labelCounts;
        for(const auto id:ids) {
            const auto& track=tracks.constFind(id).value();
            const QString value=facetValue(track,field).trimmed();
            if(value.isEmpty()) continue;
            const auto identity=track.rawMetadata.value(identityFields.value(field)).toInt();
            const QString groupKey=identity>0 ? QStringLiteral("id:%1").arg(identity)
                    : QStringLiteral("value:%1").arg(value);
            if(!groups.contains(groupKey)) {labels.insert(groupKey,value);++labelCounts[value];}
            groups[groupKey].append(id);
        }
        auto keys=groups.keys();
        const bool numeric=field=="bpm" || field=="rating" || field=="year";
        std::sort(keys.begin(),keys.end(),[&](const QString& a,const QString& b) {
            if(numeric) return labels.value(a).toDouble()<labels.value(b).toDouble();
            const int comparison=QString::localeAwareCompare(labels.value(a),labels.value(b));
            return comparison==0 ? a<b : comparison<0;
        });
        for(const auto& key:keys) {
            const auto value=labels.value(key);
            const QString label=labelCounts.value(value)>1
                    ? value+QStringLiteral(" (%1)").arg(key.section(':',1)) : value;
            m_facetTracks.insert(label,groups.value(key));
            auto* item=new QListWidgetItem(label,m_facets);
            item->setSizeHint(QSize(260,44));
        }

        m_level=BrowserLevel::FacetValues;m_sidebar->hide();m_library->hide();
        m_emptySpace->hide();m_facets->show();m_preview->show();m_leftHeader->setText(m_selectedCategory);
        m_breadcrumb->setText(m_selectedCategory);
        m_focus=NavigationTarget::Facets;
        if(m_facets->count()) m_facets->setCurrentRow(0);
        else setPreview(m_facetField=="artist" ? "ALBUM" : m_facetField=="key" ? "RELATED KEY" : "TRACK",{});
        m_facets->setFocus();updateFacetPreview();refreshTable();
    }
    void showHistory() {
        const auto currentCatalog=catalog();
        if(!currentCatalog) {showNotice("USB unavailable.");return;}
        m_facetField="history";m_facetTracks.clear();m_facets->clear();
        const auto tracks=currentCatalog->tracks();
        for(const auto& history:currentCatalog->histories()) {
            const QString name=history.name.isEmpty()
                    ? QStringLiteral("HISTORY %1").arg(history.id) : history.name;
            const QString label=m_facetTracks.contains(name)
                    ? name+QStringLiteral(" (%1)").arg(history.id) : name;
            QList<quint32> ids;
            for(const auto id:history.trackIds) if(tracks.contains(id)) ids.append(id);
            m_facetTracks.insert(label,ids);
            auto* item=new QListWidgetItem(label,m_facets);
            item->setSizeHint(QSize(260,44));
        }

        m_level=BrowserLevel::FacetValues;m_sidebar->hide();m_library->hide();m_preview->show();
        m_emptySpace->hide();m_facets->show();m_leftHeader->setText("HISTORY");m_breadcrumb->setText("HISTORY");
        m_focus=NavigationTarget::Facets;m_facets->setCurrentRow(0);
        m_facets->setFocus();updateFacetPreview();refreshTable();
        if(!m_facets->count()) setPreview("TRACK",{});
    }
    QFileInfoList folderEntries(const QString& path) const {
        const QString root=QFileInfo(m_currentRoot).canonicalFilePath();
        const QString canonical=QFileInfo(path).canonicalFilePath();
        if(root.isEmpty() || !(canonical==root || canonical.startsWith(root+"/"))) return {};
        QFileInfoList result;
        for(const auto& entry:QDir(canonical).entryInfoList(QDir::Dirs|QDir::Files|QDir::NoDotAndDotDot,QDir::DirsFirst|QDir::Name|QDir::IgnoreCase)) {
            if(entry.isSymLink()) continue;
            if(entry.isDir() || SoundSourceProxy::isFileNameSupported(entry.fileName())) result.append(entry);
        }
        return result;
    }
    void showFolder(const QString& path) {
        m_folderPath=path;m_folderPaths.clear();m_facetField="folder";m_facets->clear();
        m_level=BrowserLevel::FacetValues;m_leftColumn->show();m_sidebar->hide();m_library->hide();
        m_facets->show();m_emptySpace->hide();m_leftHeader->setText("FOLDER");m_breadcrumb->setText("FOLDER");
        for(const auto& entry:folderEntries(path)) {
            m_folderPaths.insert(entry.fileName(),entry.absoluteFilePath());
            auto* item=new QListWidgetItem(entry.fileName(),m_facets);
            item->setData(Qt::UserRole,entry.isDir());
        }
        m_focus=NavigationTarget::Facets;m_facets->setFocus();
        if(m_facets->count()) m_facets->setCurrentRow(0);
        updateFacetPreview();if(!m_facets->count()) setPreview("FOLDER",{});
    }
    void showMatching() {
        m_facetField="matching";m_facets->clear();m_level=BrowserLevel::FacetValues;
        m_leftColumn->show();m_sidebar->hide();m_library->hide();m_facets->show();m_emptySpace->hide();
        m_leftHeader->setText("DECK");m_breadcrumb->setText("MATCHING");
        m_facets->addItems({"DECK 1","DECK 2"});m_facets->setCurrentRow(0);
        m_focus=NavigationTarget::Facets;m_facets->setFocus();updateFacetPreview();
    }
    void chooseFacet() {
        if(!m_facets->currentItem()) return;
        const auto value=m_facets->currentItem()->text();

        if(m_facetField=="folder") {
            const QString path=m_folderPaths.value(value);
            if(m_facets->currentItem()->data(Qt::UserRole).toBool()) {showFolder(path);return;}
            if(m_backend->showUsbFolder(m_currentRoot,m_folderPath)) {
                showTrackList(BrowserLevel::FacetValues);m_breadcrumb->setText(QFileInfo(m_folderPath).fileName());
                m_pendingFolderTrack=path;selectPendingFolderTrack();
            }
            return;
        }
        auto* feature=m_backend->rekordboxFeature();
        if(!feature || !feature->showTrackIds(m_currentRoot,
                m_facetTracks.value(value), m_facetField+":"+value)) {
            showNotice("USB unavailable.");return;
        }
        m_breadcrumb->setText(m_selectedCategory+" / "+value);
        showTrackList(BrowserLevel::FacetValues);
    }
    void enterTree(const QModelIndex& index) {
        if(!index.isValid() || m_level!=BrowserLevel::Hierarchy) return;
        m_sidebar->selectIndex(index);m_focus=NavigationTarget::Tree;
        if(model()->hasChildren(index)) {
            m_sidebar->setRootIndex(index);
            m_breadcrumb->setText(index.data().toString());
            if(model()->rowCount(index)>0)
                m_sidebar->selectIndex(model()->index(0,0,index));
            updatePlaylistPreview();
            return;
        }
        activate(index);
        m_breadcrumb->setText(index.data().toString());
        showTrackList(BrowserLevel::Hierarchy);
    }
    void restoreNavigationFocus(NavigationTarget focus) {
        if(m_pages->currentIndex()==1) {m_focus=NavigationTarget::Source;m_sources->setFocus();return;}
        if(focus==NavigationTarget::Categories || m_level==BrowserLevel::Categories || m_level==BrowserLevel::Notice) {
            m_focus=NavigationTarget::Categories;m_categories->setFocus();return;
        }
        if(focus==NavigationTarget::Tree && m_sidebar->isVisible()) {m_focus=NavigationTarget::Tree;m_sidebar->setFocus();}
        else if(focus==NavigationTarget::Facets && m_facets->isVisible()) {m_focus=NavigationTarget::Facets;m_facets->setFocus();}
        else if(focus==NavigationTarget::Categories) {m_focus=NavigationTarget::Categories;m_categories->setFocus();}
        else focusTracks();
    }
    void focusTracks() {
        refreshTable(); m_focus=NavigationTarget::TrackList;
        if(auto* table=m_library->getCurrentTrackTableView()) {
            table->setFocus();
            if(auto* rows=table->model();rows && !table->currentIndex().isValid() && rows->rowCount()>0) table->setCurrentIndex(rows->index(0,0));
        }
    }
    void showSources() {
        m_cueSummary->hide();
        if(m_detailedInfo->isVisible()) ControlObject::set(ConfigKey("[RX3Info]","visible"),0);
        m_keyboard->hide();m_search->hide();m_categories->show();m_searchRail->hide();m_breadcrumb->show();m_searchCount->hide();
        m_source->setText("SOURCE");
        m_sourceDetails->setCurrentWidget(m_info);m_settingsRoot.clear();m_sourceActionIndex=-1;
        m_pages->setCurrentIndex(1);m_breadcrumb->setText("SOURCE");m_focus=NavigationTarget::Source;
        refreshSources();
        updateSourceActionHighlight();updateSourceAppearance();
        m_sources->setFocus();
    }
    QString deviceRoot(const QPersistentModelIndex& device) const {
        return device.data(SidebarModel::DataRole).toList().value(0).toString();
    }
    QString deviceStatus(const QPersistentModelIndex& device) const {
        return device.data(SidebarModel::DataRole).toList().value(2).toString();
    }
    bool deviceReady(const QPersistentModelIndex& device) const {
        if(!device.isValid() || deviceStatus(device)!="ready") return false;
        auto* feature=m_backend?m_backend->rekordboxFeature():nullptr;
        const auto currentCatalog=feature ? feature->catalogForRoot(deviceRoot(device)) : nullptr;
        return currentCatalog && !currentCatalog->browseMenu().categories.isEmpty();
    }
    QPersistentModelIndex sourceDeviceForNavigation() const {
        if(m_pages->currentIndex()==1) {
            const int row=m_sources->indexOfTopLevelItem(m_sources->currentItem());
            return row>=0 && row<int(m_devices.size())?m_devices[row]:QPersistentModelIndex();
        }
        return m_selectedDevice;
    }
    bool prepareSourceNavigation() {
        showBrowser();
        const auto device=sourceDeviceForNavigation();
        if(!deviceReady(device)) {showSources();return false;}
        if(m_pages->currentIndex()==1 || device!=m_selectedDevice) chooseSource();
        return deviceReady(m_selectedDevice);
    }
    void browseSelectedSource() {
        if(!prepareSourceNavigation()) return;
        m_sourceDetails->setCurrentWidget(m_info);
        m_pages->setCurrentIndex(0);previewCategory(m_categories->currentRow());
    }
    void openSourceSection(const QString& section) {
        if(!prepareSourceNavigation()) return;
        if(section=="TAG LIST") {
            toolTracks(m_tagLists[tagIdentity()].ids(),"TAG LIST");return;
        }
        for(int row=0;row<m_categories->count();++row)
            if(m_categories->item(row)->text().section('\n',1)==section) {
                m_categories->setCurrentRow(row);selectCategory(row);return;
            }
        // An export without playlists still has a valid empty playlist view.
        m_pages->setCurrentIndex(0);m_selectedCategory=section;m_level=BrowserLevel::Notice;
        m_library->hide();m_sidebar->hide();m_facets->hide();m_leftColumn->hide();
        m_emptySpace->hide();setPreview(section,{});m_breadcrumb->setText(section);
        m_focus=NavigationTarget::Categories;
    }
    WRx3Shortcut* settingsService() const {
        for(auto* widget:window()->findChildren<QWidget*>("RX3Shortcut"))
            if(auto* service=dynamic_cast<WRx3Shortcut*>(widget)) return service;
        return nullptr;
    }
    bool settingsSourceAvailable() const {
        const auto device=sourceDeviceForNavigation();
        return !m_settingsRoot.isEmpty() && device.isValid() && deviceRoot(device)==m_settingsRoot &&
                QDir(m_settingsRoot).exists();
    }
    void openSourceSettings() {
        if(m_pages->currentIndex()!=1 || !m_sourceSettings->isEnabled()) return;
        m_settingsRoot=deviceRoot(sourceDeviceForNavigation());
        if(!settingsSourceAvailable()) return;
        m_sourceActionIndex=-1;updateSourceActionHighlight();m_sourceDetails->setCurrentWidget(m_sourceMenu);
        m_sourceMenu->showMenu("MY SETTINGS",{
            toolAction("LOAD",[this]{
                if(!settingsSourceAvailable()) {closeSourceSettings();return;}
                const auto service=settingsService();
                const auto result=service?service->loadSettings(m_settingsRoot):QString("Settings service unavailable.");
                m_sourceMenu->findChild<QLabel*>("RX3ToolsStatus")->setToolTip(result);
                m_sourceMenu->message(result.startsWith("MY SETTINGS loaded")?
                        "MY SETTINGS loaded. Hardware-only preferences are not applied.":result);
            }),
            toolAction("BACKGROUND COLOR",[this]{showSourceColors(false);}),
            toolAction("WAVEFORM COLOR",[this]{showSourceColors(true);})
        },[this]{closeSourceSettings();});
        m_sourceMenu->findChild<QListWidget*>("RX3SourceSettingsActions")->setFocus();
    }
    void closeSourceSettings() {
        m_sourceDetails->setCurrentWidget(m_info);m_settingsRoot.clear();
        m_sourceActionIndex=m_sources->topLevelItemCount();updateSourceActionHighlight();
    }
    void showSourceColors(bool waveform) {
        if(!settingsSourceAvailable()) {closeSourceSettings();return;}
        const auto names=waveform?QStringList{"BLUE","RGB","3BAND"}:rx3::sourceColorNames();
        std::vector<ToolAction> choices;
        for(int index=0;index<names.size();++index) choices.push_back(toolAction(names[index],[this,index,waveform]{
            if(!settingsSourceAvailable()) {closeSourceSettings();return;}
            QString error;
            if(waveform) {
                if(auto* service=settingsService()) service->setWaveformColor(index);
                else error="Settings service unavailable.";
            } else error=rx3::saveSourceColor(m_settingsRoot,index);
            if(!error.isEmpty()) {m_sourceMenu->message(error);return;}
            updateSourceAppearance();openSourceSettings();
        }));
        m_sourceMenu->showMenu(waveform?"WAVEFORM COLOR":"BACKGROUND COLOR",std::move(choices),[this]{openSourceSettings();});
        const int selected=waveform?qRound(ControlObject::get(ConfigKey("[RX3Settings]","waveform_color"))):
                rx3::readSourceColor(m_settingsRoot);
        m_sourceMenu->move(selected);
    }
    void updateSourceAppearance() {
        for(int row=0;row<int(m_devices.size());++row) {
            const auto root=deviceRoot(m_devices[row]);
            if(auto* item=m_sources->topLevelItem(row)) item->setData(0,Qt::UserRole+1,rx3::readSourceColor(root));
        }
        m_sources->viewport()->update();
        const auto root=m_pages->currentIndex()==1?deviceRoot(sourceDeviceForNavigation()):m_currentRoot;
        const auto color=rx3::sourceColor(rx3::readSourceColor(root)).name();
        m_sourceLabel->setText(QString("USB%1").arg(m_usbSlots.value(root)));
        m_sourceLabel->setStyleSheet("background:"+color+";color:white;padding:8px;font-size:16px;");
        m_sourceLabel->setVisible(m_pages->currentIndex()!=1 && m_pages->currentWidget()!=m_tools &&
                m_pages->currentWidget()!=m_utility && !root.isEmpty());
        const int row=m_sources->indexOfTopLevelItem(m_sources->currentItem());
        if(m_pages->currentIndex()==1 && !m_refreshingSources) updateSourceInfo(row);
    }
    void updateSourceActionHighlight() {
        const int count=m_sources->topLevelItemCount();
        m_sourceSettings->setProperty("encoderFocus",m_sourceActionIndex==count);
        m_sourceSettings->style()->unpolish(m_sourceSettings);m_sourceSettings->style()->polish(m_sourceSettings);
        for(int i=0;i<m_headerButtons.size();++i) {
            auto* button=m_headerButtons[i];button->setProperty("encoderFocus",m_sourceActionIndex==count+1+i);
            button->style()->unpolish(button);button->style()->polish(button);button->update();
        }
        m_sourceSettings->update();
    }
    void onDeviceModelChanged() {
        if(m_pages->currentIndex()==1) {refreshSources();return;}
        if(!deviceReady(m_selectedDevice)) {
            m_selectedDevice=QPersistentModelIndex();
            m_currentRoot.clear();
            qApp->setProperty("rx3SettingsUsbRoot",QString());
            m_preview->hide();
            showSources();
        }
    }
    void refreshSources() {
        if(m_refreshingSources) return;
        m_refreshingSources=true;
        const int previous=qMax(0,m_sources->indexOfTopLevelItem(m_sources->currentItem()));
        const QString previousRoot=m_sources->currentItem()
                ? m_sources->currentItem()->data(0,Qt::UserRole).toString() : QString();
        m_sources->clear();m_devices.clear();
        // Enumerate current feature indexes, since a provider may have reset
        // its child model during discovery.
        for(int i=0;i<model()->rowCount();++i) {
            const auto root=model()->index(i,0);
            if(root.data(SidebarModel::IconNameRole).toString()!="rekordbox") continue;
            for(int r=0;r<model()->rowCount(root);++r) {
                const auto device=model()->index(r,0,root);
                const QString suffix=deviceReady(device) ? QStringLiteral("  ›")
                        : deviceStatus(device)=="error" ? QStringLiteral("  ·  ERROR")
                        : QStringLiteral("  ·  READING…");
                auto* item=new QTreeWidgetItem(m_sources,{"▣   "+device.data().toString()+suffix});
                item->setData(0,Qt::UserRole,device.data(SidebarModel::DataRole).toList().value(0));
                m_devices.push_back(device);
            }
        }
        int selected=qMin(previous,m_sources->topLevelItemCount()-1);
        for(int row=0;row<m_sources->topLevelItemCount();++row)
            if(m_sources->topLevelItem(row)->data(0,Qt::UserRole).toString()==previousRoot) {selected=row;break;}
        m_sources->setCurrentItem(m_sources->topLevelItem(selected));
        QSet<QString> present;
        for(const auto& device:m_devices) present.insert(deviceRoot(device));
        for(auto it=m_usbSlots.begin();it!=m_usbSlots.end();) {
            if(!present.contains(it.key())) it=m_usbSlots.erase(it);else ++it;
        }
        for(int row=0;row<int(m_devices.size());++row) {
            const QString root=deviceRoot(m_devices[row]);
            if(!m_usbSlots.contains(root)) {
                int slot=1;while(m_usbSlots.values().contains(slot)) ++slot;
                m_usbSlots.insert(root,slot);
            }
            m_sources->topLevelItem(row)->setText(0,QString("▣   USB%1   %2").arg(m_usbSlots.value(root))
                    .arg(deviceReady(m_devices[row]) ? "›" : deviceStatus(m_devices[row])=="error" ? "ERROR" : "READING…"));
            m_sources->topLevelItem(row)->setData(0,Qt::UserRole+1,rx3::readSourceColor(root));
            m_sources->topLevelItem(row)->setData(0,Qt::UserRole+2,QString("USB%1").arg(m_usbSlots.value(root)));
            m_sources->topLevelItem(row)->setData(0,Qt::UserRole+3,deviceReady(m_devices[row])?"›":
                    deviceStatus(m_devices[row])=="error"?"ERROR":"READING…");
        }
        if(m_devices.empty()) {
            auto* empty=new QTreeWidgetItem(m_sources,{"NO DEVICE"});
            empty->setFlags(Qt::NoItemFlags);
        }
        if(m_devices.empty()) selected=0;
        m_sources->setCurrentItem(m_sources->topLevelItem(selected));
        m_refreshingSources=false;
        updateSourceInfo(selected);
    }
    void updateSourceInfo(int row) {
        if(!m_settingsRoot.isEmpty() && (row<0 || row>=int(m_devices.size()) ||
                deviceRoot(m_devices[row])!=m_settingsRoot || !deviceReady(m_devices[row]))) closeSourceSettings();
        if(row>=0 && row<int(m_devices.size()) && deviceReady(m_devices[row])) {
            const auto root=deviceRoot(m_devices[row]);
            qApp->setProperty("rx3SettingsUsbRoot",root);
            qApp->setProperty("rx3SettingsUsbName",QString("USB%1").arg(m_usbSlots.value(root)));
            qApp->setProperty("rx3SettingsUsbDeviceName",m_devices[row].data(Qt::DisplayRole).toString());
        } else qApp->setProperty("rx3SettingsUsbRoot",QString());
        if(m_refreshingSources) return;
        QString songs,playlists,total,available,date;
        const bool hasDevice=row>=0 && row<int(m_devices.size());
        const bool ready=hasDevice && deviceReady(m_devices[row]);
        m_sourceSettings->setEnabled(ready);
        for(int i=1;i<=4;++i) m_headerButtons[i]->setEnabled(ready ||
                (m_pages->currentIndex()!=1 && deviceReady(m_selectedDevice)));
        if(hasDevice) {
            const auto data=m_devices[row].data(SidebarModel::DataRole).toList();
            if(ready) {songs=data.value(3).toString();playlists=data.value(4).toString();}
            QStorageInfo volume(data.value(0).toString());
            if(volume.isValid() && volume.isReady()) {
                total=QString::number(volume.bytesTotal()/1e9,'f',1);
                available=QString::number(volume.bytesAvailable()/1e9,'f',1);
            }
            const QFileInfo database(QDir(data.value(0).toString()).filePath("PIONEER/rekordbox/export.pdb"));
            if(database.exists()) date=database.lastModified().date().toString(Qt::ISODate);
        }
        auto line=[](const QString& label,const QString& value) -> QString {
            return "<tr><td style='padding:12px'>"+label+"</td><td align='right' style='padding:12px'>"+value.toHtmlEscaped()+"</td></tr>";
        };
        m_info->setText("<table width='100%' cellspacing='0'><tr><td colspan='2' style='background:#303030;padding:12px'>INFO</td></tr>"+
                line("Songs",songs)+line("Playlists",playlists)+line("Date",date)+
                line("Total",total+" GB")+line("Available",available+" GB")+
                line("Background Color",hasDevice ? rx3::sourceColorNames().value(rx3::readSourceColor(deviceRoot(m_devices[row]))) : "")+"</table>");
    }
    void chooseSource() {
        const int row=m_sources->indexOfTopLevelItem(m_sources->currentItem());
        if(row<0 || row>=int(m_devices.size())) return;
        const QModelIndex device=m_devices[row];
        if(!deviceReady(device)) {updateSourceInfo(row);return;}
        m_selectedDevice=device;
        m_currentRoot=deviceRoot(m_selectedDevice);
        qApp->setProperty("rx3SettingsUsbRoot",m_currentRoot);
        qApp->setProperty("rx3SettingsUsbName",QString("USB%1").arg(m_usbSlots.value(m_currentRoot)));
        qApp->setProperty("rx3SettingsUsbDeviceName",m_selectedDevice.data(Qt::DisplayRole).toString());
        m_pages->setCurrentIndex(0);
        m_source->setText("SOURCE");m_facets->hide();m_sidebar->hide();
        m_sourceActionIndex=-1;updateSourceActionHighlight();updateSourceAppearance();
        m_preview->hide();m_trackInfo->hide();m_loading->hide();m_library->hide();
        m_emptySpace->show();
        populateCategories();
        previewCategory(m_categories->currentRow());
        m_focus=NavigationTarget::Categories;m_categories->setFocus();updateNavigationHighlight();
        QTimer::singleShot(0,this,[this]{fitBrowseRows();});
    }
    void previewCategory(int row) {
        selectCategory(row);
        m_focus=NavigationTarget::Categories;m_categories->setFocus();updateNavigationHighlight();
    }
    void move(int delta) {
        if(m_pages->currentWidget()==m_utility) {m_utility->move(delta);return;}
        if(m_pages->currentWidget()==m_tools) {m_tools->move(delta);return;}
        if(m_pages->currentIndex()==1 && m_sourceDetails->currentWidget()==m_sourceMenu) {m_sourceMenu->move(delta);return;}
        if(m_focus==NavigationTarget::Facets) {if(m_facets->count()) m_facets->setCurrentRow(qBound(0,m_facets->currentRow()+delta,m_facets->count()-1));updateFacetPreview();return;}
        if(m_focus==NavigationTarget::Source) {
            const int count=m_sources->topLevelItemCount();
            const int row=m_sourceActionIndex>=0?m_sourceActionIndex:qMax(0,m_sources->indexOfTopLevelItem(m_sources->currentItem()));
            m_sourceActionIndex=qBound(0,row+delta,count+m_headerButtons.size());
            if(m_sourceActionIndex<count) {
                m_sources->setCurrentItem(m_sources->topLevelItem(m_sourceActionIndex));
                if(auto* item=m_sources->currentItem()) item->setSelected(true);
            }
            else m_sources->clearSelection();
            updateSourceActionHighlight();return;
        }
        if(m_focus==NavigationTarget::Categories) {if(m_categories->count()) {m_categories->setCurrentRow(qBound(0,m_categories->currentRow()+delta,m_categories->count()-1));previewCategory(m_categories->currentRow());}return;}
        if(m_focus==NavigationTarget::TrackList) {if(auto* table=m_library->getCurrentTrackTableView()) table->moveSelection(delta);return;}
        QModelIndex index=selectedTreeIndex();
        if(!index.isValid() || index==m_sidebar->rootIndex()) index=model()->index(0,0,m_sidebar->rootIndex());
        for(int n=0;n<qAbs(delta);++n) {
            const auto next=delta>0?m_sidebar->indexBelow(index):m_sidebar->indexAbove(index);
            if(next.isValid()) index=next;
        }
        m_sidebar->selectIndex(index);
        updatePlaylistPreview();
    }
    void enter() {
        if(m_pages->currentWidget()==m_utility) {m_utility->enter();return;}
        if(m_pages->currentWidget()==m_tools) {m_tools->enter();return;}
        if(m_pages->currentIndex()==1 && m_sourceDetails->currentWidget()==m_sourceMenu) {m_sourceMenu->enter();return;}
        if(m_focus==NavigationTarget::Facets) {chooseFacet();return;}
        if(m_focus==NavigationTarget::Source) {
            const int count=m_sources->topLevelItemCount();
            if(m_sourceActionIndex==count) m_sourceSettings->click();
            else if(m_sourceActionIndex>count) m_headerButtons[m_sourceActionIndex-count-1]->click();
            else chooseSource();return;
        }
        if(m_focus==NavigationTarget::Categories) {selectCategory(m_categories->currentRow());return;}
        // LOAD 1/2 is the only operation that loads the selected row. ENTER
        // on the track list is deliberately a no-op instead of unexpectedly
        // navigating backwards or bypassing the deck-specific load controls.
        if(m_focus==NavigationTarget::TrackList) return;
        enterTree(selectedTreeIndex());
    }
    void back() {
        if(m_pages->currentWidget()==m_utility) {m_utility->back();return;}
        if(m_pages->currentWidget()==m_tools) {if(m_toolPreview) m_toolPreview->cancel();m_tools->goBack();return;}
        if(m_pages->currentIndex()==1 && m_sourceDetails->currentWidget()==m_sourceMenu) {m_sourceMenu->goBack();return;}
        if(m_focus==NavigationTarget::Source) {
            if(!deviceReady(m_selectedDevice)) return;
            m_pages->setCurrentIndex(0);m_source->setText("SOURCE");m_sourceActionIndex=-1;
            updateSourceActionHighlight();updateSourceAppearance();m_focus=NavigationTarget::Categories; m_categories->setFocus();updateNavigationHighlight();return;
        }
        if(m_selectedCategory=="SEARCH") {
            m_search->clear();m_search->hide();m_keyboard->hide();m_categories->show();
            m_categories->setCurrentRow(m_searchReturnCategory);previewCategory(m_searchReturnCategory);return;
        }
        if(m_focus==NavigationTarget::Categories) {showSources();return;}
        if(m_level==BrowserLevel::Tracks) {
            if(m_returnLevel==BrowserLevel::Categories) {previewCategory(m_categories->currentRow());return;}
            m_leftColumn->show();
            m_level=m_returnLevel;m_library->hide();m_trackInfo->hide();
            m_emptySpace->hide();
            m_preview->show();
            refreshTable();
            if(m_level==BrowserLevel::Hierarchy) {
                m_sidebar->show();m_focus=NavigationTarget::Tree;
                m_sidebar->setFocus();updatePlaylistPreview();return;
            }
            if(m_level==BrowserLevel::FacetValues) {
                m_facets->show();m_focus=NavigationTarget::Facets;m_facets->setFocus();updateFacetPreview();return;
            }
        }
        if(m_level==BrowserLevel::Hierarchy && m_focus==NavigationTarget::Tree) {
            const auto root=m_sidebar->rootIndex();
            if(root.isValid() && root!=m_selectedDevice) {
                m_sidebar->setRootIndex(root.parent());m_sidebar->selectIndex(root);updatePlaylistPreview();return;
            }
            const auto parent=selectedTreeIndex().parent();
            if(parent.isValid() && parent!=m_sidebar->rootIndex()) {
                m_sidebar->selectIndex(parent);m_sidebar->collapse(parent);
                updatePlaylistPreview();return;
            }
        }
        if(m_facetField=="folder" && m_level==BrowserLevel::FacetValues && m_folderPath!=m_currentRoot) {
            showFolder(QFileInfo(m_folderPath).dir().absolutePath());return;
        }
        if(m_level!=BrowserLevel::Categories) {
            previewCategory(m_categories->currentRow());return;
        }
        showSources();
    }
    void showTools();
    void showUtility();
    void closeUtility() {
        if(m_toolPreview) m_toolPreview->cancel();
        m_utilitySessionActive=false;
        m_pages->setCurrentIndex(m_utilityReturnPage);m_focus=m_utilityReturnFocus;
        m_breadcrumb->setText(m_utilityReturnBreadcrumb);updateSourceAppearance();
        updateNavigationHighlight();
    }
    void showTagTools();
    void openUtilityTools(QString title,std::function<void()> open);
    void showBankTools();
    void showFilterTools();
    void showMemoryTools(int deck);
    void showPreviewTools();
    void showPlaybackTools();
    void advanceContinuous(int deck);
    void showAudioTools();
    void showBeatFxTools();
    void showRecordingTools();
    void refreshSessionWork();
    void toolTracks(const QList<quint32>& ids,const QString& name);
    QString tagIdentity() const;
    void saveTagPlaylist();
    using ToolAction=WRx3ToolMenu::Action;
    static ToolAction toolAction(QString label,std::function<void()> execute) {return {[label]{return label;},std::move(execute),{}};}
    ToolAction audioValue(QString label,QString group,QString key,QString configuredKey = {});
    WRx3ToolMenu* m_tools=nullptr;
    WRx3Utility* m_utility=nullptr;
    QTimer* m_menuHoldTimer=nullptr;
    bool m_menuHeld=false;
    bool m_utilitySessionActive=false;
    int m_utilityReturnPage=0;
    NavigationTarget m_utilityReturnFocus=NavigationTarget::Source;
    QString m_utilityReturnBreadcrumb;
    UserSettingsPointer m_config;
    TrackPointer m_toolTrack;
    quint32 m_toolPlaylist=0;
    rx3::TrackFilter m_filter;
    QHash<QString,rx3::TagList> m_tagLists;
    std::unique_ptr<rx3::TouchPreview> m_toolPreview;
    double m_previewPosition=0;
    QString m_recordingRoot,m_recordingDevice;
    QHash<QString,int> m_historySaved;
    QSet<QString> m_continuousLoads;
    QSet<QString> m_historyBusy;
    QString m_historyName=QString("NauticMixxx %1").arg(QDateTime::currentDateTime().toString("yyyy-MM-dd HH-mm-ss"));
    int m_browseRowHeight=44;
    QWidget* m_leftColumn;
    QLabel* m_leftHeader;
    QWidget* m_keyboard;
    QPushButton* m_keyboardToggle;
    bool m_numericKeyboard=false;
    bool m_searchHasAllTracks=false;
    int m_searchReturnCategory=0;
    QMap<QString,int> m_usbSlots;
    QMap<QString,QString> m_folderPaths;
    QString m_folderPath;
    QString m_pendingFolderTrack;
    QLabel* m_trackInfo;
    QLabel* m_cueSummary;
    QPushButton* m_infoButton;
    Rx3TrackInfoPanel* m_detailedInfo;
    struct InfoOrigin {
        QString root,category,breadcrumb,field,folder;
        QPersistentModelIndex treeRoot,treeSelection;QStringList facetLabels;int categoryRow=0;
        QList<quint32> ids;QMap<QString,QList<quint32>> facets;
        BrowserLevel returnLevel;int facetRow=0;
    };
    QHash<QString,InfoOrigin> m_origins;
    QHash<QString,InfoOrigin> m_playbackOrigins;
    QLabel* m_loading;
    QWidget* m_preview;
    Rx3PreviewTable* m_previewTracks;
    QWidget* m_emptySpace;
    WLibrary* m_library;
    Library* m_backend;
    QListWidget* m_facets;
    QString m_facetField;
    QMap<QString,QList<quint32>> m_facetTracks;
    QList<quint16> m_categoryIds;
    WLibrarySidebar* m_sidebar;
    QPushButton* m_source;
    QPushButton* m_sourceSettings;
    QLabel* m_sourceLabel;
    QWidget* m_headerWidget;
    QStackedWidget* m_sourceDetails;
    WRx3ToolMenu* m_sourceMenu;
    QString m_settingsRoot;
    QList<QPushButton*> m_headerButtons;
    bool m_externalNavigation=false;
    int m_externalAction=-1;
    int m_sourceActionIndex=-1;
    QPushButton* m_breadcrumb;
    QLabel* m_info;
    QLineEdit* m_search;
    QLabel* m_searchCount;
    QListWidget* m_searchRail;
    QListWidget* m_categories;
    QStackedWidget* m_pages;
    QTreeWidget* m_sources;
    QPersistentModelIndex m_selectedDevice;
    std::vector<QPersistentModelIndex> m_devices;
    std::vector<std::unique_ptr<ControlObject>> m_controls;
    NavigationTarget m_focus=NavigationTarget::Categories;
    NavigationTarget m_resumeFocus=NavigationTarget::TrackList;
    BrowserLevel m_level=BrowserLevel::Categories;
    BrowserLevel m_returnLevel=BrowserLevel::Categories;
    QString m_selectedCategory;
    bool m_refreshingSources=false;
    QString m_currentRoot;
};

#include "widget/wrx3browsertools.h"
#include "widget/wrx3browserutility.h"
