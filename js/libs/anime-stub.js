/**
 * Anime.js Browser Stub
 * Provides a minimal compatible interface for anime animations
 */

// Main anime function
function anime(options) {
  if (!options) return { pause: () => {}, play: () => {} };
  
  let {
    targets = [],
    duration = 1000,
    delay = 0,
    easing = 'easeOutQuad',
    complete = null,
    ...otherProps
  } = options;

  // Convert CSS selector string to DOM elements
  if (typeof targets === 'string') {
    targets = document.querySelectorAll(targets);
  }
  
  // Convert NodeList to Array if needed
  if (targets instanceof NodeList) {
    targets = Array.from(targets);
  }
  
  // Ensure targets is an array
  if (!Array.isArray(targets)) {
    targets = [targets];
  }

  // For browser compatibility, use requestAnimationFrame or setTimeout
  const startTime = Date.now() + delay;
  
  const animate_frame = () => {
    const now = Date.now();
    const progress = Math.min((now - startTime) / duration, 1);
    
    // Apply CSS transforms for the most common animations
    if (targets.length) {
      targets.forEach((target, index) => {
        // Calculate delay for this element (for stagger)
        const elementDelay = typeof delay === 'function' ? delay(index) : delay;
        const elementStartTime = Date.now() - (Date.now() - startTime - elementDelay);
        const elementProgress = Math.min(Math.max((Date.now() - elementStartTime) / duration, 0), 1);
        
        if (elementProgress > 0) {
          if (otherProps.opacity !== undefined) {
            target.style.opacity = otherProps.opacity instanceof Array 
              ? otherProps.opacity[0] + (otherProps.opacity[1] - otherProps.opacity[0]) * elementProgress
              : otherProps.opacity;
          }
          if (otherProps.translateY !== undefined) {
            const startY = otherProps.translateY instanceof Array ? otherProps.translateY[0] : 0;
            const endY = otherProps.translateY instanceof Array ? otherProps.translateY[1] : otherProps.translateY;
            const y = startY + (endY - startY) * elementProgress;
            target.style.transform = `translateY(${y}px)`;
          }
          if (otherProps.scale !== undefined) {
            const startScale = otherProps.scale instanceof Array ? otherProps.scale[0] : 1;
            const endScale = otherProps.scale instanceof Array ? otherProps.scale[1] : otherProps.scale;
            const scale = startScale + (endScale - startScale) * elementProgress;
            target.style.transform = `scale(${scale})`;
          }
        }
      });
    }
    
    if (progress < 1) {
      requestAnimationFrame(animate_frame);
    } else if (complete) {
      complete();
    }
  };
  
  requestAnimationFrame(animate_frame);
  
  return {
    pause: () => {},
    play: () => {}
  };
}

// Stagger helper
anime.stagger = function(delay) {
  return (index) => index * delay;
};

// Export for use
if (typeof window !== 'undefined') {
  window.anime = anime;
}

