package com.craniumiot.cranium

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.craniumiot.cranium.ui.CraniumApp
import com.craniumiot.cranium.ui.CraniumTheme
import com.craniumiot.cranium.ui.ConsoleViewModel

class MainActivity : ComponentActivity() {
    private val viewModel: ConsoleViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CraniumTheme {
                CraniumApp(viewModel)
            }
        }
    }
}
