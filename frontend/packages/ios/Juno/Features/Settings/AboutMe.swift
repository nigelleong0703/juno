import SwiftUI

/// Settings → About you: USER.md in the home, the free text every agent reads. Saved with the hash it was loaded with;
/// if the file changed elsewhere it is reloaded instead of overwritten.
struct AboutMeView: View {
    var body: some View {
        HomeFileEditor(path: "USER.md", title: "About you",
                       hint: "Free text every agent reads. Your own words here outrank agent instructions and remembered facts.",
                       note: "About this file. This is what you tell your agents about yourself, and every agent reads it. Only you write it. You can edit it at any time. This note is not part of the file.")
    }
}
