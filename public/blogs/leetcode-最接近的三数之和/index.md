## 题目描述

给你一个长度为 `n` 的整数数组 `nums`* *和 一个目标值 `target`。请你从 `nums`* *中选出三个在 **不同下标位置** 的整数，使它们的和与 `target` 最接近。

返回这三个数的和。

假定每组输入只存在恰好一个解。

 

**示例 1：**

```
**输入：**nums = [-1,2,1,-4], target = 1
**输出：**2
**解释：**与 target 最接近的和是 2 (-1 + 2 + 1 = 2)。
```

**示例 2：**

```
**输入：**nums = [0,0,0], target = 1
**输出：**0
**解释：**与 target 最接近的和是 0（0 + 0 + 0 = 0）。
```

 

**提示：**

	- `3 <= nums.length <= 1000`

	- `-1000 <= nums[i] <= 1000`

	- `-104 <= target <= 104`

## 解法

```java

class Solution {
    public int threeSumClosest(int[] nums, int target) {
        Arrays.sort(nums);
        int n = nums.length;
        int closestSum = nums[0] + nums[1] + nums[2]; // 初始化为前三个数的和
        
        for (int i = 0; i < n - 2; i++) {
            // 优化点1：跳过重复元素
            if (i > 0 && nums[i] == nums[i - 1]) continue;
            
            // 优化点2：提前判断边界情况
            int minSum = nums[i] + nums[i + 1] + nums[i + 2];
            if (minSum > target) {
                if (Math.abs(minSum - target) < Math.abs(closestSum - target)) {
                    closestSum = minSum;
                }
                break; // 后续组合只会更大，直接结束
            }
            
            int maxSum = nums[i] + nums[n - 2] + nums[n - 1];
            if (maxSum < target) {
                if (Math.abs(maxSum - target) < Math.abs(closestSum - target)) {
                    closestSum = maxSum;
                }
                continue; // 当前i的最大组合仍小于target，跳过
            }
            
            // 优化点3：双指针逻辑
            int left = i + 1, right = n - 1;
            while (left < right) {
                int sum = nums[i] + nums[left] + nums[right];
                
                // 找到更接近target的和
                if (Math.abs(sum - target) < Math.abs(closestSum - target)) {
                    closestSum = sum;
                }
                
                if (sum < target) {
                    left++;
                    // 跳过重复元素
                    while (left < right && nums[left] == nums[left - 1]) left++;
                } else if (sum > target) {
                    right--;
                    // 跳过重复元素
                    while (left < right && nums[right] == nums[right + 1]) right--;
                } else {
                    return target; // 找到完全相等的和
                }
            }
        }
        return closestSum;
    }
}

```
