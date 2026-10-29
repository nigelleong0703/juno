package io.github.nigelleong0703.juno.ui.team

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AccountView
import io.github.nigelleong0703.juno.contract.PersonRelationView
import io.github.nigelleong0703.juno.contract.PersonView
import io.github.nigelleong0703.juno.contract.PossibleMatch
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.TeamLoad
import io.github.nigelleong0703.juno.state.confirmRelation
import io.github.nigelleong0703.juno.state.deleteRelation
import io.github.nigelleong0703.juno.state.linkAccount
import io.github.nigelleong0703.juno.state.renamePerson
import io.github.nigelleong0703.juno.state.teamList
import io.github.nigelleong0703.juno.state.unlinkAccount
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/**
 * People (Team, owner-approved 2026-10-26): the people the agents know, the accounts they chat from and how they relate, and
 * the accounts the backend suggests belong to someone. Linking a suggestion is the owner's call; rename, unlink, confirm a
 * relation and remove one are the owner's own edits, and each one reads the list again.
 */
@Composable
internal fun TeamPeople() {
    val world = LocalWorld.current
    var reload by remember { mutableIntStateOf(0) }
    var people by remember { mutableStateOf<TeamLoad<PersonView>>(TeamLoad.Loading) }
    var matches by remember { mutableStateOf<List<PossibleMatch>>(emptyList()) }
    var renaming by remember { mutableStateOf<PersonView?>(null) }

    LaunchedEffect(reload) {
        val loaded = world.teamList<PersonView>("/v1/people?limit=50")
        people = loaded
        // The suggestions only matter once the people are there (web waits on the same list).
        val found = if (loaded is TeamLoad.Loaded) world.teamList<PossibleMatch>("/v1/people/possible-matches") else TeamLoad.Failed
        matches = (found as? TeamLoad.Loaded<PossibleMatch>)?.items.orEmpty()
    }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (matches.isNotEmpty()) MatchesSection(matches) { reload++ }
        TeamListView(people, emptyText = "No people yet", offlineText = "This is unavailable right now.") { items ->
            PeopleRows(items, onChanged = { reload++ }, onRename = { renaming = it })
        }
    }
    renaming?.let { person -> RenameSheet(person) { changed -> renaming = null; if (changed) reload++ } }
}

/** A suggested account: linking it to the person it matches is the owner's decision. */
@Composable
private fun MatchesSection(matches: List<PossibleMatch>, onChanged: () -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Possible matches", color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.SemiBold))
        matches.forEach { match ->
            val account = match.account
            val person = match.person
            if (account != null && person != null) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "${account.name ?: account.platform.orEmpty()} · ${person.name.orEmpty()}", color = c.fg, style = junoText(TextSize.Md),
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                    )
                    JunoButton("Link", { scope.launch { if (world.linkAccount(person.id, account.id)) onChanged() } }, size = ButtonSize.Sm)
                }
            }
        }
    }
}

/** People, ten at a time. */
@Composable
private fun PeopleRows(people: List<PersonView>, onChanged: () -> Unit, onRename: (PersonView) -> Unit) {
    var limit by remember { mutableIntStateOf(10) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        people.take(limit).forEach { person -> PersonCard(person, onChanged, onRename) }
        ShowMore(shown = minOf(limit, people.size), total = people.size, onMore = { limit += 10 })
    }
}

@Composable
private fun PersonCard(person: PersonView, onChanged: () -> Unit, onRename: (PersonView) -> Unit) {
    val c = JunoTheme.colors
    val accounts = person.accounts.orEmpty()
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                person.name.orEmpty(), color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold),
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            if (person.isOwner == true) Text("You", color = c.fgMuted, style = junoText(TextSize.Sm))
            TeamAction("Rename") { onRename(person) }
        }
        if (accounts.isNotEmpty()) {
            Text("Accounts", color = c.fgMuted, style = junoText(TextSize.Xs, FontWeight.SemiBold))
            accounts.forEach { account -> AccountRow(account, onChanged) }
        }
        RelationRows(person.relations.orEmpty(), onChanged)
    }
}

@Composable
private fun AccountRow(account: AccountView, onChanged: () -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            listOfNotNull(account.platform, account.name).joinToString(" · "), color = c.fgMuted, style = junoText(TextSize.Sm),
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        TeamAction("Unlink") { scope.launch { if (world.unlinkAccount(account.id)) onChanged() } }
    }
}

/** A person's relations, three at a time; each can be confirmed (when not yet) or removed. */
@Composable
private fun RelationRows(relations: List<PersonRelationView>, onChanged: () -> Unit) {
    if (relations.isEmpty()) return
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    var limit by remember { mutableIntStateOf(3) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Relations", color = c.fgMuted, style = junoText(TextSize.Xs, FontWeight.SemiBold))
        relations.take(limit).forEach { relation ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "${relation.kindLabel ?: relation.kind.orEmpty()} · ${relation.otherName.orEmpty()}", color = c.fgMuted,
                    style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (relation.confirmed != true) TeamAction("Confirm") { scope.launch { if (world.confirmRelation(relation.id)) onChanged() } }
                TeamAction("Remove") { scope.launch { if (world.deleteRelation(relation.id)) onChanged() } }
            }
        }
        ShowMore(shown = minOf(limit, relations.size), total = relations.size, onMore = { limit += 3 })
    }
}

/** Renames a person; Save writes the name, then the list is read again. */
@Composable
private fun RenameSheet(person: PersonView, onDone: (changed: Boolean) -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(person.name.orEmpty()) }
    var saving by remember { mutableStateOf(false) }
    JunoSheet(
        title = "Rename", onDismiss = { onDone(false) }, primary = "Save",
        primaryEnabled = draft.trim().isNotEmpty() && !saving, loading = saving,
        onPrimary = {
            saving = true
            scope.launch { onDone(world.renamePerson(person.id, draft.trim())) }
        },
    ) {
        FormTextField(draft, { draft = it }, placeholder = "Name")
    }
}
