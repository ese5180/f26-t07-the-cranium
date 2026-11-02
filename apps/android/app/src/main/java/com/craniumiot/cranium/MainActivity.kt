package com.craniumiot.cranium

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.craniumiot.cranium.ui.CraniumApp
import com.craniumiot.cranium.ui.CraniumTheme
import com.craniumiot.cranium.ui.CraniumViewModel

class MainActivity : ComponentActivity() {
    private val viewModel: CraniumViewModel by viewModels()

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
