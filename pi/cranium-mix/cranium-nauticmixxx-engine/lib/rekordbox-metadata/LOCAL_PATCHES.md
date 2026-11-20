# Local generated-reader hardening

The DeviceSQL reader has one local constructor initialization beyond the generated schema output: `rekordbox_pdb_t::row_ref_t` initializes `m_body` to null. A lazy `body()` constructor can throw before assigning this pointer; cleanup must not delete an indeterminate pointer. Preserve this initialization when regenerating with a compiler that does not emit it automatically.

The application validates page chains and live-row ranges in `src/library/rekordbox/rekordboxdatabase.cpp` before invoking the generated metadata decoder. Playlist strings and relations are decoded through that bounded module. This does not change the on-disk format or write to the source database.
