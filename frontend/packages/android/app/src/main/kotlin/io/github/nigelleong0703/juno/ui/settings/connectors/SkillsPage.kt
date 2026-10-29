package io.github.nigelleong0703.juno.ui.settings.connectors

import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import io.github.nigelleong0703.juno.contract.Skill
import io.github.nigelleong0703.juno.state.description
import io.github.nigelleong0703.juno.state.name
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError

/** The skills the agents can use: name and description, searchable by name (iOS `GlobalPageView(.skills)`). */
@Composable
fun SkillsPage(skills: List<Skill>?, loadError: String?) {
    var query by rememberSaveable { mutableStateOf("") }
    if (skills == null) {
        if (loadError != null) SettingsError(loadError) else LoadingLine()
        return
    }
    JunoTextField(value = query, onValueChange = { query = it }, label = "Search skills", modifier = Modifier.fillMaxWidth())
    val shown = skills.filter { query.isEmpty() || it.name.orEmpty().contains(query, ignoreCase = true) }
    if (shown.isEmpty()) SettingsEmpty("No skills found.")
    else GroupedSection {
        shown.forEach { skill -> GroupedRow(title = skill.name.orEmpty(), subtitle = skill.description) }
    }
}
