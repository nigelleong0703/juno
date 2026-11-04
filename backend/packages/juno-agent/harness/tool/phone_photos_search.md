---
id: tool.phone_photos_search
placement: T
vars: []
---
Search the photo library on the owner's iPhone by date, place, kind (photo or video) and favourites, newest first. Returns for each match an id, the date, the size, the rough place it was taken (coordinates) and a few labels the phone worked out on the device ("beach", "dog"); never the picture itself. Only the photos the owner let Juno see are searched (it may be a chosen few; the answer says when). To show one, call phone_photos_send with its id. Photos are private: search only for what the user asked. Runs on the owner's iPhone through the Juno app, so it works only while the app is open (otherwise it is refused and says so).
